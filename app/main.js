import { createInterface } from "readline";
import { delimiter, resolve, join } from "path";
import { accessSync, constants, statSync, writeFileSync, openSync, existsSync, readdirSync } from "fs";
import { spawnSync, spawn } from "child_process";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
  completer: completer,
});

const builtins = ["echo", "type", "exit", "pwd", "cd", "complete", "jobs", "history"];
let tabTracker = { line: "", count: 0 };
const commandHistory = [];
const backgroundJobs = [];
const registeredCompletions = new Map();

function completer(line) {
  const words = line.split(" ");
  const lastSpaceIndex = line.lastIndexOf(" ");
  
  let uniqueHits = [];
  let prefix = line; 
  let customScriptHandled = false;

  // =========================================================================
  // 1. CUSTOM SCRIPT COMPLETION
  // =========================================================================
  if (words.length > 1) {
    const command = words[0];
    const currentWord = words[words.length - 1];
    
    if (registeredCompletions.has(command)) {
      const scriptPath = registeredCompletions.get(command);
      
      try {
        const previousWord = words[words.length - 2] || "";
        const env = Object.assign({}, process.env, {
          COMP_LINE: line,
          COMP_POINT: line.length.toString()
        });
        
        const result = spawnSync(scriptPath, [command, currentWord, previousWord], { 
          encoding: "utf8",
          env: env
        });
        
        if (result.stdout) {
          const output = result.stdout.trim();
          if (output) {
            // Split by newline to support multiple candidate matches!
            uniqueHits = output.split(/\r?\n/).map(c => c.trim()).filter(c => c).sort();
            prefix = currentWord;
            customScriptHandled = true; // Tell Step 2 to skip
          }
        }
      } catch (err) {
        // Silently fall through to default completion
      }
    }
  }

  // =========================================================================
  // 2. STANDARD COMPLETION (Only runs if custom script yielded nothing)
  // =========================================================================
  if (!customScriptHandled) {
    if (lastSpaceIndex !== -1) {
      // 2A. Filename/Directory Completion
      prefix = line.substring(lastSpaceIndex + 1);
      
      let dirToSearch = process.cwd();
      let filePrefix = prefix;
      let pathPrefix = "";

      if (prefix.includes("/")) {
        const lastSlashIndex = prefix.lastIndexOf("/");
        pathPrefix = prefix.substring(0, lastSlashIndex + 1); 
        filePrefix = prefix.substring(lastSlashIndex + 1);    
        dirToSearch = pathPrefix; 
      }

      try {
        const files = readdirSync(dirToSearch);
        uniqueHits = files
          .filter(f => f.startsWith(filePrefix))
          .map(f => pathPrefix + f)
          .sort();
      } catch (e) {}
    } else {
      // 2B. Command Completion
      const builtinHits = builtins.filter((cmd) => cmd.startsWith(line));
      const externalHits = getExternalExecutables(line);
      uniqueHits = Array.from(new Set([...builtinHits, ...externalHits])).sort();
    }
  }

  // =========================================================================
  // 3-6. UNIFIED HIT HANDLING (Applies to Scripts, Files, and Commands)
  // =========================================================================

  // 3. Exact single match
  if (uniqueHits.length === 1) {
    tabTracker = { line: "", count: 0 }; 
    let match = uniqueHits[0];
    let appendChar = " "; 
    
    // Only check for directory slashes if it was a standard file completion
    if (!customScriptHandled && lastSpaceIndex !== -1) {
      try {
        if (statSync(resolve(match)).isDirectory()) {
          appendChar = "/";
        }
      } catch (e) {}
    }
    
    rl.write(match.slice(prefix.length) + appendChar);
    return [[], line]; 
  }

  // 4. No matches
  if (uniqueHits.length === 0) {
    tabTracker = { line: "", count: 0 }; 
    process.stdout.write("\x07"); 
    return [[], line]; 
  }

  // 5. Multiple Matches: Longest Common Prefix (LCP)
  const lcp = getLongestCommonPrefix(uniqueHits);

  if (lcp.length > prefix.length) {
    tabTracker = { line: "", count: 0 }; 
    rl.write(lcp.slice(prefix.length));
    return [[], line]; 
  }

  // 6. Multiple matches: Print hits on double tab
  if (tabTracker.line !== line) {
    tabTracker.line = line;
    tabTracker.count = 1;
    process.stdout.write("\x07"); 
    return [[], line];
  } else {
    tabTracker.count++;
    if (tabTracker.count === 2) {
      const displayHits = uniqueHits.map(h => {
        let baseName = h;
        
        // Strip paths and add directory slashes ONLY for standard file completions
        if (!customScriptHandled && lastSpaceIndex !== -1) { 
          const idx = h.lastIndexOf("/");
          if (idx !== -1) {
            baseName = h.substring(idx + 1);
          }
          try {
            if (statSync(resolve(h)).isDirectory()) {
              baseName += "/";
            }
          } catch (e) {}
        }
        return baseName;
      });

      process.stdout.write("\n" + displayHits.join("  ") + "\n");
      process.stdout.write(rl.getPrompt() + line);
      tabTracker.count = 0; 
    }
    return [[], line];
  }
}

function checkAndReapJobs() {
  for (let i = 0; i < backgroundJobs.length; i++) {
    if (backgroundJobs[i].status === "Done") {
      const job = backgroundJobs[i];
      
      let marker = " ";
      if (i === backgroundJobs.length - 1) {
        marker = "+";
      } else if (i === backgroundJobs.length - 2) {
        marker = "-";
      }
      
      const status = job.status.padEnd(24, " ");
      const displayCommand = job.command.replace(/\s*&$/, "");
      
      console.log(`[${job.id}]${marker}  ${status}${displayCommand}`);
      
      // Remove it from the array and adjust the index
      backgroundJobs.splice(i, 1);
      i--;
    }
  }
}

// THIS IS THE CRITICAL MISSING PIECE
function promptAfterReaping() {
  setTimeout(() => {
    checkAndReapJobs();
    rl.prompt();
  }, 15);
}

function getLongestCommonPrefix(words) {
  if (words.length === 0) return "";
  let prefix = words[0];
  for (let i = 1; i < words.length; i++) {
    while (words[i].indexOf(prefix) !== 0) {
      prefix = prefix.substring(0, prefix.length - 1);
      if (prefix === "") return "";
    }
  }
  return prefix;
}

function getExternalExecutables(prefix) {
  const matches = new Set();
  const pathEnv = process.env.PATH || '';
  const dirs = pathEnv.split(delimiter);

  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) continue;

      const files = readdirSync(dir);
      for (const file of files) {
        if (file.startsWith(prefix)) {
          const filePath = join(dir, file);
          try {
            const stats = statSync(filePath);
            const isExecutable = (stats.mode & constants.S_IXUSR) !== 0;
            if (stats.isFile() && isExecutable) {
              matches.add(file);
            }
          } catch (e) { }
        }
      }
    } catch (e) { }
  }
  return Array.from(matches);
}

function isShellBuiltin(command) {
  return builtins.includes(command);
}

function findExecutable(command) {
  const path = process.env.PATH || "";
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const fullPath = resolve(directory, command);
    try {
      const stats = statSync(fullPath);
      if (stats.isFile()) {
        accessSync(fullPath, constants.X_OK);
        return fullPath;
      }
    } catch (e) {}
  }
  return null;
}

function parseArguments(input) {
  const args = [];
  let currentWord = "";
  let activeQuote = null;
  let isEscaped = false;
  let hasWord = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (isEscaped) {
      currentWord += char;
      isEscaped = false;
      hasWord = true;
      continue;
    }

    if (char === "\\") {
      if (activeQuote === "'") {
        currentWord += char;
      } else {
        isEscaped = true;
      }
      hasWord = true;
      continue;
    }

    if (activeQuote) {
      if (char === activeQuote) {
        activeQuote = null;
      } else {
        currentWord += char;
      }
      hasWord = true;
      continue;
    }

    if (char === "'" || char === '"') {
      activeQuote = char;
      hasWord = true;
      continue;
    }

    if (char === " " || char === "\t") {
      if (hasWord) {
        args.push(currentWord);
        currentWord = "";
        hasWord = false;
      }
      continue;
    }

    currentWord += char;
    hasWord = true;
  }

  if (hasWord) {
    args.push(currentWord);
  }
  return args;
}

rl.prompt();

rl.on("line", (command) => {
  const trimmedCommand = command.trim();
  if (trimmedCommand) {
    commandHistory.push(trimmedCommand);
  }

  const parsedCommand = parseArguments(command);

  if (parsedCommand.length === 0) {
    promptAfterReaping();
    return;
  }

  let runInBackground = false;
  if (parsedCommand[parsedCommand.length - 1] === "&") {
    runInBackground = true;
    parsedCommand.pop(); // Remove the '&' token
  }
  
  if (parsedCommand.length === 0) {
    promptAfterReaping();
    return;
  }

  let targetOutFile = null;
  let outMode = "w"; 
  let targetErrFile = null;
  let errMode = "w"; 

  let errAppIndex = parsedCommand.findIndex((arg) => arg === "2>>");
  if (errAppIndex !== -1) {
    targetErrFile = parsedCommand[errAppIndex + 1];
    errMode = "a"; 
    parsedCommand.splice(errAppIndex, 2);
  } else {
    let errIndex = parsedCommand.findIndex((arg) => arg === "2>");
    if (errIndex !== -1) {
      targetErrFile = parsedCommand[errIndex + 1];
      errMode = "w"; 
      parsedCommand.splice(errIndex, 2);
    }
  }

  let outAppIndex = parsedCommand.findIndex((arg) => arg === ">>" || arg === "1>>");
  if (outAppIndex !== -1) {
    targetOutFile = parsedCommand[outAppIndex + 1];
    outMode = "a"; 
    parsedCommand.splice(outAppIndex, 2);
  } else {
    let outIndex = parsedCommand.findIndex((arg) => arg === ">" || arg === "1>");
    if (outIndex !== -1) {
      targetOutFile = parsedCommand[outIndex + 1];
      outMode = "w"; 
      parsedCommand.splice(outIndex, 2);
    }
  }

  if (targetOutFile) writeFileSync(targetOutFile, "", { flag: outMode });
  if (targetErrFile) writeFileSync(targetErrFile, "", { flag: errMode });

  if (parsedCommand.includes("|")) {
    // 1. Break the command into separate pipeline stages
    const pipeline = [];
    let currentStage = [];
    for (const arg of parsedCommand) {
      if (arg === "|") {
        pipeline.push(currentStage);
        currentStage = [];
      } else {
        currentStage.push(arg);
      }
    }
    pipeline.push(currentStage);

    let prevProcess = null;
    let prevBuiltinOutput = "";
    let lastProcess = null;

    // 2. Execute each stage and pipe them together
    for (let i = 0; i < pipeline.length; i++) {
      const stageArgs = pipeline[i];
      if (stageArgs.length === 0) continue;

      const cmd = stageArgs[0];
      const args = stageArgs.slice(1);
      const isLast = (i === pipeline.length - 1);
      const isFirst = (i === 0);

      if (isShellBuiltin(cmd)) {
        let output = "";
        if (cmd === "echo") output = args.join(" ") + "\n";
        else if (cmd === "pwd") output = process.cwd() + "\n";
        else if (cmd === "type") {
          const target = args[0];
          if (isShellBuiltin(target)) output = `${target} is a shell builtin\n`;
          else {
            const execPath = findExecutable(target);
            if (execPath) output = `${target} is ${execPath}\n`;
            else output = `${target}: not found\n`;
          }
        }
        
        if (isLast) {
          if (targetOutFile) writeFileSync(targetOutFile, output, { flag: outMode });
          else process.stdout.write(output);
        } else {
          prevBuiltinOutput = output;
        }
        
        // Drain the previous process so it doesn't hang waiting to write to our builtin
        if (prevProcess && prevProcess.stdout) {
          prevProcess.stdout.resume(); 
        }
        
        prevProcess = null; // A builtin doesn't have a stream for the next process
      } else {
        const execPath = findExecutable(cmd);
        if (!execPath) {
          console.log(`${cmd}: command not found`);
          if (prevProcess && prevProcess.stdout) prevProcess.stdout.resume();
          promptAfterReaping();
          return;
        }

        let stdIn = isFirst ? 'inherit' : 'pipe';
        let stdOut = isLast ? (targetOutFile ? openSync(targetOutFile, outMode) : 'inherit') : 'pipe';
        let stdErr = isLast ? (targetErrFile ? openSync(targetErrFile, errMode) : 'inherit') : 'inherit';

        if (isFirst && runInBackground) stdIn = 'ignore';

        const currProcess = spawn(execPath, args, { argv0: cmd, stdio: [stdIn, stdOut, stdErr] });

        // Connect stdin to the previous output
        if (!isFirst) {
          if (prevProcess) {
            prevProcess.stdout.pipe(currProcess.stdin);
          } else {
            currProcess.stdin.write(prevBuiltinOutput);
            currProcess.stdin.end();
          }
        }

        prevProcess = currProcess;
        if (isLast) {
          lastProcess = currProcess;
        }
      }
    }

    // 3. Wait for the final pipeline stage to finish
    if (lastProcess) {
      if (runInBackground) {
        let newJobId = 1;
        while (backgroundJobs.some(j => j.id === newJobId)) newJobId++;
        console.log(`[${newJobId}] ${lastProcess.pid}`);
        backgroundJobs.push({
          id: newJobId,
          pid: lastProcess.pid,
          command: command.trim(),
          status: "Running"
        });
        lastProcess.on("exit", () => {
          const job = backgroundJobs.find(j => j.pid === lastProcess.pid);
          if (job) job.status = "Done";
        });
        promptAfterReaping();
      } else {
        lastProcess.on("close", () => promptAfterReaping());
      }
    } else {
      promptAfterReaping();
    }
    
    return; // Exit early to skip the single-command logic below
  }

  const cmd = parsedCommand[0];
  const args = parsedCommand.slice(1);

  function writeOut(text) {
    if (targetOutFile) {
      writeFileSync(targetOutFile, text + "\n", { flag: outMode });
    } else {
      console.log(text);
    }
  }

  if (cmd === "exit") {
    rl.close();
    return;
  } 
  else if (cmd === "echo") {
    writeOut(args.join(" "));
  } 
  else if (cmd === "type") {
    const targetCmd = args[0];
    if (isShellBuiltin(targetCmd)) {
      writeOut(`${targetCmd} is a shell builtin`);
    } else {
      const executablePath = findExecutable(targetCmd);
      if (executablePath) {
        writeOut(`${targetCmd} is ${executablePath}`);
      } else {
        writeOut(`${targetCmd}: not found`);
      }
    }
  } 
  else if (cmd === "pwd") {
    writeOut(process.cwd());
  } 
  else if (cmd === "cd") {
    let dir = args[0] || "~";
    if (dir === "~") dir = process.env.HOME;
    try {
      process.chdir(dir);
    } catch (error) {
      const errorMsg = `cd: ${dir}: No such file or directory`;
      if (targetErrFile) {
        writeFileSync(targetErrFile, errorMsg + "\n", { flag: errMode });
      } else {
        console.log(errorMsg);
      }
    }
  } 
  else if (cmd === "complete") {
    if (args.length === 0) {
      promptAfterReaping(); 
      return;
    }

    if (args[0] === "-C" && args.length >= 3) {
      const scriptPath = args[1].replace(/^['"]|['"]$/g, '');
      
      for (let i = 2; i < args.length; i++) {
        const targetCommand = args[i].replace(/^['"]|['"]$/g, '');
        registeredCompletions.set(targetCommand, scriptPath);
      }
    } 
    else if (args[0] === "-p" && args.length === 1) {
      if (registeredCompletions.size > 0) {
        const sortedCommands = Array.from(registeredCompletions.keys()).sort();
        
        for (const targetCommand of sortedCommands) {
          const scriptPath = registeredCompletions.get(targetCommand);
          writeOut(`complete -C '${scriptPath}' ${targetCommand}`);
        }
      }
    }
    else if (args[0] === "-p" && args.length === 2) {
      const targetCommand = args[1].replace(/^['"]|['"]$/g, '');
      
      if (registeredCompletions.has(targetCommand)) {
        const scriptPath = registeredCompletions.get(targetCommand);
        writeOut(`complete -C '${scriptPath}' ${targetCommand}`);
      } else {
        writeOut(`complete: ${targetCommand}: no completion specification`);
      }
    }
    else if (args[0] === "-r" && args.length >= 2) {
      for (let i = 1; i < args.length; i++) {
        const targetCommand = args[i].replace(/^['"]|['"]$/g, '');
        
        if (registeredCompletions.has(targetCommand)) {
          registeredCompletions.delete(targetCommand);
        } else {
          writeOut(`complete: ${targetCommand}: no completion specification`);
        }
      }
    }
  }
  else if (cmd === "jobs") {
    // 1. Force a synchronous check with the OS to beat the speed mismatch
    backgroundJobs.forEach((job) => {
      if (job.status === "Running") {
        try {
          // Sending signal 0 checks if the process exists. 
          // If it doesn't, it throws an error immediately.
          process.kill(job.pid, 0); 
        } catch (error) {
          job.status = "Done";
        }
      }
    });

    // 2. Format and print jobs
    backgroundJobs.forEach((job, index) => {
      let marker = " ";
      if (index === backgroundJobs.length - 1) marker = "+";
      else if (index === backgroundJobs.length - 2) marker = "-";
      
      const status = job.status.padEnd(24, " ");
      let displayCommand = job.command;
      
      // The tester expects the '&' removed for 'Done' jobs
      if (job.status === "Done") displayCommand = displayCommand.replace(/\s*&$/, "");
      
      writeOut(`[${job.id}]${marker}  ${status}${displayCommand}`);
    });

    // 3. Remove "Done" jobs so they aren't printed a second time
    for (let i = backgroundJobs.length - 1; i >= 0; i--) {
      if (backgroundJobs[i].status === "Done") backgroundJobs.splice(i, 1);
    }
  }
  else if (cmd === "history") {
    let limit = commandHistory.length;
    if (args.length > 0 && !isNaN(parseInt(args[0], 10))) {
      limit = parseInt(args[0], 10);
    }
    
    const startIndex = Math.max(0, commandHistory.length - limit);
    const historyToShow = commandHistory.slice(startIndex);
    
    const lines = historyToShow.map((h, idx) => 
      `${String(startIndex + idx + 1).padStart(5, " ")}  ${h}`
    );
    writeOut(lines.join("\n"));
  }
  else {
    let executablePath = findExecutable(cmd);

    if (executablePath) {
      if (runInBackground) {
        let bgStdio = [
          "ignore", 
          targetOutFile ? openSync(targetOutFile, outMode) : "inherit", 
          targetErrFile ? openSync(targetErrFile, errMode) : "inherit"
        ];
        
        let newJobId = 1;
        while (backgroundJobs.some(j => j.id === newJobId)) newJobId++;

        const child = spawn(executablePath, args, { argv0: cmd, stdio: bgStdio });
        console.log(`[${newJobId}] ${child.pid}`);

        backgroundJobs.push({
          id: newJobId,
          pid: child.pid,
          command: command.trim(),
          status: "Running"
        });

        child.on("exit", () => {
          const job = backgroundJobs.find(j => j.pid === child.pid);
          if (job) job.status = "Done";
        });
      } else {
        let stdioOpt = ["inherit", "inherit", "inherit"];
        if (targetOutFile) stdioOpt[1] = openSync(targetOutFile, outMode); 
        if (targetErrFile) stdioOpt[2] = openSync(targetErrFile, errMode); 
        
        spawnSync(executablePath, args, { argv0: cmd, stdio: stdioOpt });
      }
    } else {
      const errorMsg = `${cmd}: command not found`;
      if (targetErrFile) writeFileSync(targetErrFile, errorMsg + "\n", { flag: errMode });
      else console.log(errorMsg);
    }
  }
  
  promptAfterReaping();
});