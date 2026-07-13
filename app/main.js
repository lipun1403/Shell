const readline = require("readline");

// default interface with '$' sign
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "$ ",
});

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
    if(cmd == "type" || cmd == "echo" || cmd == "exit") {
      console.log(`${cmd} is a shell builtin`);
    }
    else {
      console.log(`${cmd}: not found`);      
    }
  }
  else {
    console.log(`${command}: command not found`);
  }
    rl.prompt();
})