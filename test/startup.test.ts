import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(distRoot, "src");

function run(entrypoint: string, args: readonly string[] = []) {
  return spawnSync(process.execPath, [resolve(sourceRoot, entrypoint), ...args], {
    encoding: "utf8",
    env: { ...process.env, NEWSZNAC_PORT: "0", NEWSZNAC_DATABASE_PATH: ":memory:" },
  });
}

test("CLI starts and returns structured health output", () => {
  const result = run("cli.js", ["health"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { service: "cli", status: "ok" });
});

for (const worker of ["collection", "analysis"] as const) {
  test(`${worker} worker starts`, () => {
    const result = run(`workers/${worker}.js`);

    assert.equal(result.status, 0, result.stderr);
    const messages = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(messages[0], {
      service: `${worker}-worker`,
      status: "ready",
      watch: false,
    });
    if (worker === "collection") assert.equal(messages[1]?.status, "cycle-complete");
  });
}

test("web application starts on loopback and reports readiness", async (context) => {
  const child = spawn(process.execPath, [resolve(sourceRoot, "server.js")], {
    env: { ...process.env, NEWSZNAC_PORT: "0", NEWSZNAC_DATABASE_PATH: ":memory:" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill());

  const [chunk] = (await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(([code]) => {
      throw new Error(`web process exited before readiness (code ${String(code)})`);
    }),
  ])) as [Buffer];
  const message = JSON.parse(chunk.toString()) as Record<string, unknown>;

  assert.equal(message.service, "web");
  assert.equal(message.status, "ready");
  assert.equal(message.host, "127.0.0.1");
  assert.equal(typeof message.port, "number");
});

test("normal start supervises web, collection, and analysis processes on one SQLite file", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "newzsnac-startup-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const pidPath = join(directory, "newzsnac.pid");
  const child = spawn(process.execPath, [resolve(sourceRoot, "main.js")], {
    env: {
      ...process.env,
      NEWSZNAC_PORT: "0",
      NEWSZNAC_DATABASE_PATH: join(directory, "reader.sqlite"),
      NEWSZNAC_PID_PATH: pidPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
  const deadline = Date.now() + 10_000;
  while (!(output.includes('"service":"web"') && output.includes('"service":"collection-worker"') && output.includes('"service":"analysis-worker"'))) {
    if (child.exitCode !== null) throw new Error(`supervisor exited with ${child.exitCode}: ${errorOutput}`);
    if (Date.now() >= deadline) throw new Error(`services were not all ready: ${output}\n${errorOutput}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  const stopped = spawnSync(process.execPath, [resolve(sourceRoot, "stop.js")], {
    encoding: "utf8",
    env: { ...process.env, NEWSZNAC_PID_PATH: pidPath },
  });
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual(JSON.parse(stopped.stdout), { service: "newzsnac", status: "stopped" });
  const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  assert.equal(code, 0, `unexpected supervisor exit: ${String(code)} ${String(signal)}`);

  const stoppedAgain = spawnSync(process.execPath, [resolve(sourceRoot, "stop.js")], {
    encoding: "utf8",
    env: { ...process.env, NEWSZNAC_PID_PATH: pidPath },
  });
  assert.equal(stoppedAgain.status, 0, stoppedAgain.stderr);
  assert.deepEqual(JSON.parse(stoppedAgain.stdout), { service: "newzsnac", status: "already-stopped" });
});
