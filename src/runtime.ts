import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RuntimeRecord {
  readonly pid: number;
  readonly cwd: string;
}

export type StopStatus = "stopped" | "already-stopped";

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRuntimeRecord(value: unknown): value is RuntimeRecord {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeRecord>;
  return Number.isInteger(candidate.pid) && Number(candidate.pid) > 0
    && typeof candidate.cwd === "string" && candidate.cwd.length > 0;
}

export function readRuntimeFile(path: string): RuntimeRecord | null {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid Newzsnac runtime file: ${path}`);
  }
  if (!isRuntimeRecord(parsed)) throw new Error(`Invalid Newzsnac runtime file: ${path}`);
  return parsed;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, "ESRCH")) return false;
    throw error;
  }
}

export function claimRuntimeFile(path: string, record: RuntimeRecord): void {
  mkdirSync(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = readRuntimeFile(path);
      if (existing !== null && processIsAlive(existing.pid)) {
        throw new Error(`Newzsnac is already running with PID ${existing.pid}`);
      }
      if (existing !== null) releaseRuntimeFile(path, existing);
    }
  }

  throw new Error(`Could not claim Newzsnac runtime file: ${path}`);
}

export function releaseRuntimeFile(path: string, owner: RuntimeRecord): void {
  const existing = readRuntimeFile(path);
  if (existing === null || existing.pid !== owner.pid || existing.cwd !== owner.cwd) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

export async function stopRecordedRuntime(
  path: string,
  workingDirectory: string,
  timeoutMs = 10_000,
): Promise<StopStatus> {
  const record = readRuntimeFile(path);
  if (record === null) return "already-stopped";
  if (record.cwd !== workingDirectory) {
    throw new Error(`Newzsnac runtime file belongs to a different working directory: ${record.cwd}`);
  }
  if (!processIsAlive(record.pid)) {
    releaseRuntimeFile(path, record);
    return "already-stopped";
  }

  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if (!hasCode(error, "ESRCH")) throw error;
    releaseRuntimeFile(path, record);
    return "already-stopped";
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    if (readRuntimeFile(path) === null || !processIsAlive(record.pid)) {
      releaseRuntimeFile(path, record);
      return "stopped";
    }
  }
  throw new Error(`Newzsnac did not stop within ${timeoutMs}ms (PID ${record.pid})`);
}
