import { createInterface } from "readline";
import { delimiter, resolve } from "path";
import { accessSync, constants, statSync } from "fs";
import { spawnSync } from "child_process";


// default interface with '$' sign
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

  for(const directory of path.split(delimiter)) {
    if(!directory) continue;
    const fullPath = resolve(directory, command);
    try {
      const stats = statSync(fullPath);
      if(stats.isFile()) {
        accessSync(fullPath, constants.X_OK);
        return fullPath;
      }
    }
    catch(e) {
      
    }
  }
  return null;
}

function parseArguments(input) {
  const args = [];
  let currentWord = '';
  let activeQuote = null;
  let isEscaped = false;
  let hasWord = false; // Tracks if we are actively building an argument

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (isEscaped) {
      currentWord += char;
      isEscaped = false;
      hasWord = true;
      continue;
    }

    if (char === '\\') {
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
        activeQuote = null; // The quote is closed
      } else {
        currentWord += char;
      }
      hasWord = true; // Ensures "" outputs an empty string instead of nothing
      continue;
    }

    if (char === "'" || char === '"') {
      activeQuote = char;
      hasWord = true;
      continue;
    }

    if (char === ' ' || char === '\t') {
      if (hasWord) {
        args.push(currentWord);
        currentWord = '';
        hasWord = false;
      }
      continue;
    }

    currentWord += char;
    hasWord = true;
  }

  // Handle errors for unfinished inputs
  // if (activeQuote) {
  //   throw new Error(`Syntax error: Unclosed quote ${activeQuote}`);
  // }
  // if (isEscaped) {
  //   throw new Error('Syntax error: Trailing backslash');
  // }

  if (hasWord) {
    args.push(currentWord);
  }

  return args;
}

rl.prompt();

rl.on("line", (command) => {
  if(command === "exit") {
    rl.close();
    return;
  }
  else if(command.startsWith("echo ")) {
    const cmd = parseArguments(command.slice(5))
    console.log(cmd.join(" "));    
  }
  else if(command.startsWith("type ")) {
    const cmd = command.slice(5);
    if(isShellBuiltin(cmd)) {
      console.log(`${cmd} is a shell builtin`);
    }
    else {
      const executablePath = findExecutable(cmd);
      if(executablePath) {
        console.log(`${cmd} is ${executablePath}`);
      }
      else {
        console.log(`${cmd}: not found`);
      }
    }
  }
  else if(command.startsWith("cat ")) {
    const args = parseArguments(command.slice(4));
    spawnSync('cat', args, { 
      stdio: 'inherit'
    });
  }
  else if(command === "pwd") {
    console.log(process.cwd());    
  }
  else if(command.startsWith("cd ")) {
    let dir = command.slice(3).trim();
    if(dir === "~") dir = process.env.HOME;
    try {
      process.chdir(dir);
    } catch (error) {
      console.log(`cd: ${dir}: No such file or directory`);      
    }
  }
  else {
    const parsedCommand = parseArguments(command);
    
    if (parsedCommand.length === 0) {
      rl.prompt();
      return;
    }

    const cmd = parsedCommand[0];
    
    const args = parsedCommand.slice(1);

    let executablePath = findExecutable(cmd);
    
    if(executablePath) {
      spawnSync(executablePath, args, { argv0: cmd, stdio: 'inherit' });
      rl.prompt();
      return;
    }
    else {
      console.log(`${command}: command not found`);
    }
  }
  rl.prompt();
})