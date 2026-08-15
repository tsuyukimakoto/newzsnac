export type WorkerName = "collection" | "analysis";

export function announceWorker(name: WorkerName): void {
  process.stdout.write(`${JSON.stringify({ service: `${name}-worker`, status: "ready" })}\n`);
}
