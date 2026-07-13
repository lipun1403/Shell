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
  if(command.startsWith("echo ")) {
    console.log(command.slice(5));    
  }
  console.log(`${command}: command not found`);
  rl.prompt();
})