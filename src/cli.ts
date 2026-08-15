import { loadConfig } from "./config.js";

export function runCli(args: readonly string[]): number {
  const [command] = args;
  if (command === "health") {
    process.stdout.write(`${JSON.stringify({ service: "cli", status: "ok" })}\n`);
    return 0;
  }

  process.stderr.write(`${JSON.stringify({ error: "unknown_command", command: command ?? null })}\n`);
  return 2;
}

if (import.meta.filename === process.argv[1]) {
  loadConfig();
  process.exitCode = runCli(process.argv.slice(2));
}
