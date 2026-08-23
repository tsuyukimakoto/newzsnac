import type { OperationalLogger } from "../logging.js";

export type WorkerName = "collection" | "analysis";

export function announceWorker(logger: OperationalLogger, name: WorkerName): void {
  logger.info(`${name}.ready`);
}
