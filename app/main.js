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

const builtins = ["echo", "type", "exit", "pwd", "cd", "complete"];
let tabTracker = { line: "", count: 0 };

const registeredCompletions = new Map();

function completer(line) {
  const words = line.split(" ");
  
  // =========================================================================
  // 1. CUSTOM SCRIPT COMPLETION (Intercepts before standard completion)
  // =========================================================================
  if (words.length > 1) {
    const command = words[0];
    const currentWord = words[words.length - 1];
    
    // Check if we have a script registered for this command
    if (registeredCompletions.has(command)) {
      const scriptPath = registeredCompletions.get(command);
      
      try {
        const { spawnSync } = require("child_process");
        const previousWord = words[words.length - 2] || "";
        
        // Run the registered script
        const result = spawnSync(scriptPath, [command, currentWord, previousWord], { 
          encoding: "utf8" 
        });
        
        if (result.stdout) {
          const output = result.stdout.trim();
          
          if (output) {
             // Return the exact line the script gave us.
             // Node will automatically replace 'currentWord' and append a space.
            return [[output], currentWord];
          }
        }
      } catch (err) {
        // If the script fails or doesn't exist, silently fall through 
        // to your default completion behavior below.
      }
    }
  }

  const lastSpaceIndex = line.lastIndexOf(" ");
  
  let uniqueHits = [];
  let prefix = line; // What we are trying to autocomplete

  if (lastSpaceIndex !== -1) {
    // 1A. Filename/Directory Completion (contains a space)
    prefix = line.substring(lastSpaceIndex + 1);
    
    let dirToSearch = process.cwd();
    let filePrefix = prefix;
    let pathPrefix = "";

    // Check for nested path
    if (prefix.includes("/")) {
      const lastSlashIndex = prefix.lastIndexOf("/");
      pathPrefix = prefix.substring(0, lastSlashIndex + 1); // e.g., "path/to/"
      filePrefix = prefix.substring(lastSlashIndex + 1);    // e.g., "f"
      dirToSearch = pathPrefix; 
    }

    try {
      const files = readdirSync(dirToSearch);
      uniqueHits = files
        .filter(f => f.startsWith(filePrefix))
        .map(f => pathPrefix + f) // Prepend the path back onto the matches
        .sort();
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
    let match = uniqueHits[0];
    let appendChar = " "; // default to space for files/commands
    
    // Check if the match is a directory
    if (lastSpaceIndex !== -1) {
      try {
        if (statSync(resolve(match)).isDirectory()) {
          appendChar = "/";
        }
      } catch (e) {}
    }
    
    // Write the remaining characters + the correct append character (space or slash)
    rl.write(match.slice(prefix.length) + appendChar);
    
    // Return empty so Node's readline doesn't automatically add its own space
    return [[], line]; 
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
    rl.write(lcp.slice(prefix.length));
    return [[], line]; 
  }

  // 5. Multiple matches: LCP is maxed out
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
      // Map back to just the basenames and append '/' for directories
      const displayHits = uniqueHits.map(h => {
        let baseName = h;
        
        if (lastSpaceIndex !== -1) { // It's a file/directory completion
          const idx = h.lastIndexOf("/");
          if (idx !== -1) {
            baseName = h.substring(idx + 1);
          }
          
          try {
            // Check if it's a directory and append '/'
            if (statSync(resolve(h)).isDirectory()) {
              baseName += "/";
            }
          } catch (e) {}
        }
        
        return baseName;
      });

      // Print the matches separated by exactly two spaces
      process.stdout.write("\n" + displayHits.join("  ") + "\n");
      
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
  else if (cmd === "complete") {
    if (args.length === 0) return;

    // 1. Registering completions
    if (args[0] === "-C" && args.length >= 3) {
      // Strip outer quotes in case the argument parser missed them
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
          // Notice the added single quotes around ${scriptPath}
          writeOut(`complete -C '${scriptPath}' ${targetCommand}`);
        }
      }
    }
    
    // 3. Displaying a specific completion
    else if (args[0] === "-p" && args.length === 2) {
      const targetCommand = args[1].replace(/^['"]|['"]$/g, '');
      
      if (registeredCompletions.has(targetCommand)) {
        const scriptPath = registeredCompletions.get(targetCommand);
        // Notice the added single quotes around ${scriptPath}
        writeOut(`complete -C '${scriptPath}' ${targetCommand}`);
      } else {
        writeOut(`complete: ${targetCommand}: no completion specification`);
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