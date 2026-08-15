import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";

const entries = [
  ["server.js"],
  ["workers/collection.js", "--watch"],
  ["workers/analysis.js", "--watch"],
] as const;

const children: ChildProcess[] = [];
let stopping = false;

const bootstrapDatabase = openDatabase(loadConfig().databasePath);
bootstrapDatabase.close();

function stop(signal: NodeJS.Signals = "SIGTERM"): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

for (const [entry, ...arguments_] of entries) {
  const child = spawn(process.execPath, [resolve(import.meta.dirname, entry), ...arguments_], {
    env: process.env,
    stdio: "inherit",
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    process.stderr.write(`${entry} stopped unexpectedly (${signal ?? code ?? "unknown"})\n`);
    process.exitCode = code ?? 1;
    stop();
  });
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("exit", () => stop());
