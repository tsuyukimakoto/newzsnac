import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(distRoot, "src");

function run(entrypoint: string, args: readonly string[] = []) {
  return spawnSync(process.execPath, [resolve(sourceRoot, entrypoint), ...args], {
    encoding: "utf8",
    env: { ...process.env, NEWSZNAC_PORT: "0" },
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
    assert.deepEqual(JSON.parse(result.stdout), {
      service: `${worker}-worker`,
      status: "ready",
    });
  });
}

test("web application starts on loopback and reports readiness", async (context) => {
  const child = spawn(process.execPath, [resolve(sourceRoot, "server.js")], {
    env: { ...process.env, NEWSZNAC_PORT: "0" },
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
