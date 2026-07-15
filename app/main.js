import { createInterface } from "readline";
import { delimiter, resolve } from "path";
import { accessSync, constants, statSync, writeFileSync, openSync } from "fs";
import { spawnSync } from "child_process";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

function isShellBuiltin(command) {
  const builtins = ["echo", "type", "exit", "pwd", "cd"];
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

  // --- Extract > and target file once for all commands ---
  let redirectIndex = parsedCommand.findIndex((arg) => arg === ">" || arg === "1>");
  let targetFile = null;

  if (redirectIndex !== -1) {
    targetFile = parsedCommand[redirectIndex + 1];
    parsedCommand.splice(redirectIndex, 2); // Removes both ">" and "filename" from the array
  }

  const cmd = parsedCommand[0];
  const args = parsedCommand.slice(1);

  // Helper to handle built-in text output (either to screen or file)
  function writeOut(text) {
    if (targetFile) {
      writeFileSync(targetFile, text + "\n");
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
    let stdioOpt = "inherit";
    if (targetFile) {
      // route stdout (index 1) to the file descriptor
      stdioOpt = ["inherit", openSync(targetFile, "w"), "inherit"];
    }
    spawnSync("cat", args, {
      stdio: stdioOpt,
    });
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
      console.log(`cd: ${dir}: No such file or directory`);
    }
  } 
  else {
    let executablePath = findExecutable(cmd);

    if (executablePath) {
      let stdioOpt = "inherit";
      if (targetFile) {
        stdioOpt = ["inherit", openSync(targetFile, "w"), "inherit"];
      }
      spawnSync(executablePath, args, { argv0: cmd, stdio: stdioOpt });
    } else {
      console.log(`${command}: command not found`);
    }
  }
  
  rl.prompt();
});