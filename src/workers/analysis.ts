import { announceWorker } from "./runtime.js";
import { loadConfig } from "../config.js";

export function startAnalysisWorker(): void {
  announceWorker("analysis");
}

if (import.meta.filename === process.argv[1]) {
  loadConfig();
  startAnalysisWorker();
}
