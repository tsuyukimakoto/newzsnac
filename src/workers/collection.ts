import { announceWorker } from "./runtime.js";
import { loadConfig } from "../config.js";

export function startCollectionWorker(): void {
  announceWorker("collection");
}

if (import.meta.filename === process.argv[1]) {
  loadConfig();
  startCollectionWorker();
}
