import { createInterface } from "readline";
import { delimiter, resolve, join } from "path";
import { accessSync, constants, statSync, writeFileSync, openSync, existsSync, readdirSync } from "fs";
import { spawnSync } from "child_process";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
  completer: completer,
});

const builtins = ["echo", "type", "exit", "pwd", "cd"];
let tabTracker = { line: "", count: 0 };

function completer(line) {
  const lastSpaceIndex = line.lastIndexOf(" ");
  
  let uniqueHits = [];
  let prefix = line; // What we are trying to autocomplete
  let linePrefix = ""; // The portion of the command we shouldn't touch

  if (lastSpaceIndex !== -1) {
    // 1A. Filename Completion (contains a space)
    prefix = line.substring(lastSpaceIndex + 1);
    linePrefix = line.substring(0, lastSpaceIndex + 1);
    try {
      const files = readdirSync(process.cwd());
      uniqueHits = files.filter(f => f.startsWith(prefix)).sort();
    } catch (e) {
      // Ignore directory read errors
    }
  } else {
    // 1B. Command Completion (no spaces)
    const builtinHits = builtins.filter((cmd) => cmd.startsWith(line));
    const externalHits = getExternalExecutables(line);
    uniqueHits = Array.from(new Set([...builtinHits, ...externalHits])).sort();
  }

  // 2. Exact single match
  if (uniqueHits.length === 1) {
    tabTracker = { line: "", count: 0 }; // reset tracker
    // Prepend the untouched part of the command, add the match, and let Node add the trailing space
    return [[linePrefix + uniqueHits[0] + " "], line]; 
  }

  // 3. No matches
  if (uniqueHits.length === 0) {
    tabTracker = { line: "", count: 0 }; // reset tracker
    process.stdout.write("\x07"); 
    return [[], line]; 
  }

  // 4. Multiple Matches: Check for Longest Common Prefix (LCP)
  const lcp = getLongestCommonPrefix(uniqueHits);

  // If the LCP is longer than what the user typed for this word, auto-fill the difference
  if (lcp.length > prefix.length) {
    tabTracker = { line: "", count: 0 }; 
    // Write the remaining common characters directly to the buffer
    rl.write(lcp.slice(prefix.length));
    return [[], line]; 
  }

  // 5. Multiple matches: LCP is maxed out (No progress can be made)
  if (tabTracker.line !== line) {
    // First <TAB> press
    tabTracker.line = line;
    tabTracker.count = 1;
    process.stdout.write("\x07"); // Ring bell
    return [[], line];
  } else {
    // Second <TAB> press
    tabTracker.count++;
    if (tabTracker.count === 2) {
      // Print the matches separated by exactly two spaces
      process.stdout.write("\n" + uniqueHits.join("  ") + "\n");
      
      // Re-print the prompt and the user's current line
      process.stdout.write(rl.getPrompt() + line);
      
      tabTracker.count = 0; // Reset so a 3rd tab acts like a 1st tab
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
  // Split the path (using ':' on Linux/macOS or ';' on Windows)
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
            // Ensure it is a regular file and executable by the current user
            const isExecutable = (stats.mode & constants.S_IXUSR) !== 0;
            if (stats.isFile() && isExecutable) {
              matches.add(file);
            }
          } catch (e) {
            // Skip files we can't stat due to permissions
          }
        }
      }
    } catch (e) {
      // Skip directories we can't read
    }
  }

  return Array.from(matches);
}

function isShellBuiltin(command) {
  // const builtins = ["echo", "type", "exit", "pwd", "cd"];
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

  let targetOutFile = null;
  let outMode = "w"; // Default to write/overwrite
  let targetErrFile = null;
  let errMode = "w"; // Default to write/overwrite

  // --- Extract Error Redirection ---
  let errAppIndex = parsedCommand.findIndex((arg) => arg === "2>>");
  if (errAppIndex !== -1) {
    targetErrFile = parsedCommand[errAppIndex + 1];
    errMode = "a"; // Set mode to append
    parsedCommand.splice(errAppIndex, 2);
  } else {
    let errIndex = parsedCommand.findIndex((arg) => arg === "2>");
    if (errIndex !== -1) {
      targetErrFile = parsedCommand[errIndex + 1];
      errMode = "w"; // Set mode to overwrite
      parsedCommand.splice(errIndex, 2);
    }
  }

  // --- Extract Output Redirection ---
  let outAppIndex = parsedCommand.findIndex((arg) => arg === ">>" || arg === "1>>");
  if (outAppIndex !== -1) {
    targetOutFile = parsedCommand[outAppIndex + 1];
    outMode = "a"; // Set mode to append
    parsedCommand.splice(outAppIndex, 2);
  } else {
    let outIndex = parsedCommand.findIndex((arg) => arg === ">" || arg === "1>");
    if (outIndex !== -1) {
      targetOutFile = parsedCommand[outIndex + 1];
      outMode = "w"; // Set mode to overwrite
      parsedCommand.splice(outIndex, 2);
    }
  }

  // Create files immediately with the correct flag to prevent wiping appended files
  if (targetOutFile) writeFileSync(targetOutFile, "", { flag: outMode });
  if (targetErrFile) writeFileSync(targetErrFile, "", { flag: errMode });

  const cmd = parsedCommand[0];
  const args = parsedCommand.slice(1);

  // Helper to handle built-in text output (either to screen or file)
  function writeOut(text) {
    if (targetOutFile) {
      writeFileSync(targetOutFile, text + "\n", { flag: outMode });
    } else {
      console.log(text);
    }
  }

  // --- Command Routing ---
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
  else if (cmd === "cat") {
    let stdioOpt = ["inherit", "inherit", "inherit"];
    
    if (targetOutFile) {
      stdioOpt[1] = openSync(targetOutFile, outMode); // Connect success pipe to file
    }
    if (targetErrFile) {
      stdioOpt[2] = openSync(targetErrFile, errMode); // Connect error pipe to file
    }

    spawnSync("cat", args, { stdio: stdioOpt });
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
  else {
    let executablePath = findExecutable(cmd);

    if (executablePath) {
      let stdioOpt = ["inherit", "inherit", "inherit"];
      
      if (targetOutFile) {
        stdioOpt[1] = openSync(targetOutFile, outMode); // Connect success pipe to file
      }
      if (targetErrFile) {
        stdioOpt[2] = openSync(targetErrFile, errMode); // Connect error pipe to file
      }

      spawnSync(executablePath, args, { argv0: cmd, stdio: stdioOpt });
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