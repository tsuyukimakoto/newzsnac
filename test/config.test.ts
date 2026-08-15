import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

test("loadConfig returns local-first defaults", () => {
  const config = loadConfig({}, "/tmp/newzsnac-test");

  assert.equal(config.databasePath, "/tmp/newzsnac-test/data/newzsnac.sqlite");
  assert.equal(config.lmStudioUrl.href, "http://127.0.0.1:1234/v1");
  assert.equal(config.bindHost, "127.0.0.1");
  assert.equal(config.port, 4317);
});

test("loadConfig rejects a non-local LM Studio endpoint", () => {
  assert.throws(
    () => loadConfig({ NEWSZNAC_LM_STUDIO_URL: "https://example.com/v1" }),
    /must point to this computer/,
  );
});

test("loadConfig rejects a public bind address", () => {
  assert.throws(
    () => loadConfig({ NEWSZNAC_HOST: "0.0.0.0" }),
    /must be a loopback address/,
  );
});
