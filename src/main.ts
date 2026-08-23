import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { claimRuntimeFile, releaseRuntimeFile, type RuntimeRecord } from "./runtime.js";
import { createOperationalLogger, errorMessage } from "./logging.js";

const entries = [
  ["server.js"],
  ["workers/collection.js", "--watch"],
  ["workers/analysis.js", "--watch"],
] as const;

function start(): void {
  const config = loadConfig();
  const logger = createOperationalLogger({ minimumLevel: config.logLevel });
  const children: ChildProcess[] = [];
  let stopping = false;
  const runtimeRecord: RuntimeRecord = { pid: process.pid, cwd: process.cwd() };

  claimRuntimeFile(config.pidPath, runtimeRecord);
  process.on("exit", () => releaseRuntimeFile(config.pidPath, runtimeRecord));

  const bootstrapDatabase = openDatabase(config.databasePath);
  bootstrapDatabase.close();

  const stop = (signal: NodeJS.Signals = "SIGTERM"): void => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    }
  };

  for (const [entry, ...arguments_] of entries) {
    const child = spawn(process.execPath, [resolve(import.meta.dirname, entry), ...arguments_], {
      env: process.env,
      stdio: "inherit",
    });
    children.push(child);
    child.on("error", (error) => {
      logger.error("service.start-failed", { service: entry, error: errorMessage(error) });
      process.exitCode = 1;
      stop();
    });
    child.on("exit", (code, signal) => {
      if (stopping) return;
      logger.error("service.stopped", { service: entry, reason: signal ?? code ?? "unknown" });
      process.exitCode = code ?? 1;
      stop();
    });
  }

  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

try {
  start();
} catch (error) {
  createOperationalLogger().error("newzsnac.start-failed", { error: errorMessage(error) });
  process.exitCode = 1;
}
