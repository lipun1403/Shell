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
  let currentWord = "";
  let inSingleQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === "'" || char === '"') {
      inSingleQuotes = !inSingleQuotes;
    } else if (char === " " && !inSingleQuotes) {
      if (currentWord.length > 0) {
        args.push(currentWord);
        currentWord = ""; 
      }
    } else {
      currentWord += char;
    }
  }

  if (currentWord.length > 0) {
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
    let cmd = command.split(" ")[0];
    let executablePath = findExecutable(cmd);
    if(executablePath) {
      let args = command.split(" ");
      args.shift();

      const spawnChild = spawnSync(executablePath, args, {argv0: cmd, stdio: 'inherit'});
      // spawnChild.stdout.on('data', (data) => {
      //   process.stdout.write(data.toString())
      // })
      // spawnChild.stderr.on('data', (data) => {
      //   process.stderr.write(data.toString());
      // })
      // spawnChild.on('error', (err) => console.error(err.message));
      // spawnChild.on('close', (code) => {
        rl.prompt();
      // })
      return;
    }
    else console.log(`${command}: command not found`);
  }
  rl.prompt();
})