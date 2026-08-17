import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claimRuntimeFile,
  readRuntimeFile,
  releaseRuntimeFile,
  stopRecordedRuntime,
  type RuntimeRecord,
} from "../src/runtime.js";

function temporaryPidPath(): string {
  const directory = join(mkdtempSync(join(tmpdir(), "newzsnac-runtime-")), "nested");
  mkdirSync(directory);
  return join(directory, "newzsnac.pid");
}

test("runtime file is claimed exclusively and only its owner can release it", () => {
  const path = temporaryPidPath();
  const owner: RuntimeRecord = { pid: process.pid, cwd: process.cwd() };
  claimRuntimeFile(path, owner);

  assert.deepEqual(readRuntimeFile(path), owner);
  assert.throws(() => claimRuntimeFile(path, owner), /already running/);

  releaseRuntimeFile(path, { pid: process.pid + 1, cwd: process.cwd() });
  assert.equal(existsSync(path), true);
  releaseRuntimeFile(path, owner);
  assert.equal(existsSync(path), false);
});

test("claiming replaces a stale runtime file", () => {
  const path = temporaryPidPath();
  const stale: RuntimeRecord = { pid: 2_147_483_647, cwd: process.cwd() };
  const owner: RuntimeRecord = { pid: process.pid, cwd: process.cwd() };
  writeFileSync(path, `${JSON.stringify(stale)}\n`);

  claimRuntimeFile(path, owner);

  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), owner);
  releaseRuntimeFile(path, owner);
});

test("stopping is idempotent and removes a stale runtime file", async () => {
  const path = temporaryPidPath();
  assert.equal(await stopRecordedRuntime(path, process.cwd()), "already-stopped");

  claimRuntimeFile(path, { pid: 2_147_483_647, cwd: process.cwd() });
  assert.equal(await stopRecordedRuntime(path, process.cwd()), "already-stopped");
  assert.equal(existsSync(path), false);
});

test("stopping rejects a runtime file from another working directory", async () => {
  const path = temporaryPidPath();
  writeFileSync(path, `${JSON.stringify({ pid: process.pid, cwd: "/another/project" })}\n`);

  await assert.rejects(() => stopRecordedRuntime(path, process.cwd()), /different working directory/);
  assert.equal(existsSync(path), true);
});
