# Node.js Custom Shell

A lightweight, POSIX-inspired command-line shell built entirely from scratch using Node.js core modules. This project features a custom lexical analyzer and parser to handle complex shell behaviors without relying on any external packages.

## Features

* **Zero Dependencies:** Built entirely using standard Node.js libraries (`fs`, `path`, `child_process`, `readline`). 
* **Advanced Parsing:** Custom lexical analysis accurately handles single quotes, double quotes, and escape characters.
* **Built-in Commands:** Native support for essential shell commands including `cd`, `pwd`, `echo`, `type`, `exit`, `history`, and `declare`.
* **External Execution:** Dynamically resolves and executes system binaries, featuring full Windows compatibility for `.exe`, `.cmd`, and `.bat` extensions.
* **Pipelines:** Chain commands together using pipes (`|`) to stream the output of one process directly into the input of the next.
* **I/O Redirection:** Safely route standard output and standard error using standard operators (`>`, `>>`, `2>`, `2>>`).
* **Job Control:** Run long-form tasks in the background using the `&` operator.
* **Variable Expansion:** Declare, store, and expand environment variables (`$VAR`, `${VAR}`) on the fly.
* **Interactive CLI:** Features interactive tab completion for built-ins and system executables.

## Usage

Start the shell by running the main entry file directly via Node.js:

```bash
node app/main.js

Example Commands
Variables and Quotes:

Bash
$ declare GREETING="Hello World"
$ echo "${GREETING}!"
Hello World!
Piping and Redirection:

Bash
$ ls -la | grep "js" > output.txt
$ cat output.txt
Background Processes:

Bash
$ sleep 5 &
Finding Executable Types:

Bash
$ type pwd
pwd is a shell builtin
$ type cat
cat is /usr/bin/cat
Architecture Overview
This shell operates on a custom Read-Eval-Print Loop (REPL) pipeline:

Tokenization: Raw user input is broken down into tokens, preserving exact spacing inside quoted strings and resolving escape characters.

Parsing: Tokens are mapped to identify command intent, arguments, redirection targets, and pipeline connections.

Execution: Built-in commands modify the current Node process state (such as process.chdir), while external commands are safely spawned and managed asynchronously using child_process.spawn.