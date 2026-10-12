/** A sudoers authorization witness, never a command execution endpoint. */
if (process.getuid?.() !== 0) process.exit(1);
process.stdout.write("EVERYOS_AUTHORIZED\n");
