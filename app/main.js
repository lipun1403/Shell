import { createInterface } from "readline";
import { delimiter, resolve } from "path";
import { accessSync, constants, statSync } from "fs";


// default interface with '$' sign
const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

function isShellBuiltin(command) {
  const builtins = ["echo", "type", "exit"];
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

rl.prompt();

rl.on("line", (command) => {
  if(command == "exit") {
    rl.close();
    return;
  }
  else if(command.startsWith("echo ")) {
    console.log(command.slice(5));    
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
        console.log(`${cmd}: command not found`);
      }
    }
  }
  else {
    console.log(`${command}: command not found`);
  }
  rl.prompt();
})