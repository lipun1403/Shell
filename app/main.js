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

const builtins = ["echo", "type", "exit", "pwd", "cd", "complete", "jobs"];
let tabTracker = { line: "", count: 0 };
let jobIdCounter = 1;
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
  const parsedCommand = parseArguments(command);

  if (parsedCommand.length === 0) {
    rl.prompt();
    return;
  }

  let runInBackground = false;
  if (parsedCommand[parsedCommand.length - 1] === "&") {
    runInBackground = true;
    parsedCommand.pop(); // Remove the '&' token
  }
  
  if (parsedCommand.length === 0) {
    rl.prompt();
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
      rl.prompt();
      return;
    }

    // 1. Registering completions
    if (args[0] === "-C" && args.length >= 3) {
      const scriptPath = args[1].replace(/^['"]|['"]$/g, '');
      
      for (let i = 2; i < args.length; i++) {
        const targetCommand = args[i].replace(/^['"]|['"]$/g, '');
        registeredCompletions.set(targetCommand, scriptPath);
      }
    } 
    // 2. Displaying all registered completions
    else if (args[0] === "-p" && args.length === 1) {
      if (registeredCompletions.size > 0) {
        const sortedCommands = Array.from(registeredCompletions.keys()).sort();
        
        for (const targetCommand of sortedCommands) {
          const scriptPath = registeredCompletions.get(targetCommand);
          writeOut(`complete -C '${scriptPath}' ${targetCommand}`);
        }
      }
    }
    // 3. Displaying a specific completion
    else if (args[0] === "-p" && args.length === 2) {
      const targetCommand = args[1].replace(/^['"]|['"]$/g, '');
      
      if (registeredCompletions.has(targetCommand)) {
        const scriptPath = registeredCompletions.get(targetCommand);
        writeOut(`complete -C '${scriptPath}' ${targetCommand}`);
      } else {
        writeOut(`complete: ${targetCommand}: no completion specification`);
      }
    }
    // 4. Unregistering completions (-r)
    else if (args[0] === "-r" && args.length >= 2) {
      for (let i = 1; i < args.length; i++) {
        const targetCommand = args[i].replace(/^['"]|['"]$/g, '');
        
        if (registeredCompletions.has(targetCommand)) {
          registeredCompletions.delete(targetCommand);
        } else {
          // Emulate standard bash error if it doesn't exist
          writeOut(`complete: ${targetCommand}: no completion specification`);
        }
      }
    }
  }
  else if(cmd == "jobs") {
    backgroundJobs.forEach((job, index) => {
      // Determine the correct marker based on the job's position in the array
      let marker = " ";
      if (index === backgroundJobs.length - 1) {
        marker = "+"; // Most recent
      } else if (index === backgroundJobs.length - 2) {
        marker = "-"; // Second most recent
      }
      
      // Pad "Running" so the status field is exactly 24 characters long
      const status = job.status.padEnd(24, " ");
      
      writeOut(`[${job.id}]${marker}  ${status}${job.command}`);
      for (let i = backgroundJobs.length - 1; i >= 0; i--) {
        if (backgroundJobs[i].status === "Done") {
          backgroundJobs.splice(i, 1);
        }
      }
    });
  }
  else {
    let executablePath = findExecutable(cmd);

    if (executablePath) {
      if (runInBackground) {
        let bgStdio = [
          "ignore", // Ignore stdin for background tasks
          targetOutFile ? openSync(targetOutFile, outMode) : "inherit", 
          targetErrFile ? openSync(targetErrFile, errMode) : "inherit"
        ];
        
        // Use spawn (async) instead of spawnSync
        const child = spawn(executablePath, args, { argv0: cmd, stdio: bgStdio });
        console.log(`[${jobIdCounter}] ${child.pid}`);

        backgroundJobs.push({
          id: jobIdCounter,
          pid: child.pid,
          command: command.trim(),
          status: "Running"
        });

        child.on("exit", () => {
          jobEntry.status = "Done";
        });

        jobIdCounter++;
      } else {
        let stdioOpt = ["inherit", "inherit", "inherit"];
        if (targetOutFile) stdioOpt[1] = openSync(targetOutFile, outMode); 
        if (targetErrFile) stdioOpt[2] = openSync(targetErrFile, errMode); 
        
        spawnSync(executablePath, args, { argv0: cmd, stdio: stdioOpt });
      }
    } else {
      const errorMsg = `${cmd}: command not found`;
      if (targetErrFile) {
        writeFileSync(targetErrFile, errorMsg + "\n", { flag: errMode });
      } else {
        console.log(errorMsg);
      }
    }
  }
  
  rl.prompt();
});