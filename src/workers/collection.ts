import { loadConfig, type AppConfig } from "../config.js";
import { openDatabase } from "../db/database.js";
import { runCollectionCycle } from "./services.js";

const WATCH_INTERVAL_MS = 10_000;

export async function startCollectionWorker(config: AppConfig, watch = false): Promise<void> {
  const database = openDatabase(config.databasePath);
  process.stdout.write(`${JSON.stringify({ service: "collection-worker", status: "ready", watch })}\n`);
  try {
    do {
      const result = await runCollectionCycle(database, config);
      process.stdout.write(`${JSON.stringify({ service: "collection-worker", status: "cycle-complete", ...result })}\n`);
      if (watch) await delay(WATCH_INTERVAL_MS);
    } while (watch);
  } finally {
    database.close();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (import.meta.filename === process.argv[1]) {
  startCollectionWorker(loadConfig(), process.argv.includes("--watch")).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
