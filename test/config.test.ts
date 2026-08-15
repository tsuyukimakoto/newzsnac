import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";

test("loadConfig returns local-first defaults", () => {
  const config = loadConfig({}, "/tmp/newzsnac-test");

  assert.equal(config.databasePath, "/tmp/newzsnac-test/data/newzsnac.sqlite");
  assert.equal(config.lmStudioUrl.href, "http://127.0.0.1:1234/v1");
  assert.equal(config.lmStudioModel, "qwen");
  assert.equal(config.embeddingModel, null);
  assert.equal(config.embeddingMaxCharacters, 12_000);
  assert.equal(config.embeddingInputVersion, "embedding-v1");
  assert.equal(config.recommendationSimilarityThreshold, 0.86);
  assert.equal(config.analysisPromptVersion, "analysis-v2");
  assert.equal(config.translationPromptVersion, "translate-v1");
  assert.equal(config.chatContextMaxCharacters, 24_000);
  assert.equal(config.bindHost, "127.0.0.1");
  assert.equal(config.port, 4317);
});

test("loadConfig preserves SQLite's in-memory database name", () => {
  assert.equal(loadConfig({ NEWSZNAC_DATABASE_PATH: ":memory:" }).databasePath, ":memory:");
});

test("loadConfig reads .env while process environment takes precedence", () => {
  const directory = mkdtempSync(join(tmpdir(), "newzsnac-config-"));
  writeFileSync(join(directory, ".env"), [
    "NEWSZNAC_DATABASE_PATH=var/local-reader.sqlite",
    "NEWSZNAC_LM_STUDIO_URL=http://localhost:2234/v1",
    "NEWSZNAC_LM_STUDIO_MODEL=qwen/from-dotenv",
    "NEWSZNAC_PORT=5317",
  ].join("\n"));

  const fromFile = loadConfig(undefined, directory);
  assert.equal(fromFile.databasePath, join(directory, "var/local-reader.sqlite"));
  assert.equal(fromFile.lmStudioUrl.href, "http://localhost:2234/v1");
  assert.equal(fromFile.lmStudioModel, "qwen/from-dotenv");
  assert.equal(fromFile.port, 5317);

  const previous = process.env.NEWSZNAC_LM_STUDIO_MODEL;
  process.env.NEWSZNAC_LM_STUDIO_MODEL = "qwen/from-process";
  try {
    assert.equal(loadConfig(undefined, directory).lmStudioModel, "qwen/from-process");
  } finally {
    if (previous === undefined) delete process.env.NEWSZNAC_LM_STUDIO_MODEL;
    else process.env.NEWSZNAC_LM_STUDIO_MODEL = previous;
  }
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

test("loadConfig validates embedding configuration", () => {
  const config = loadConfig({
    NEWSZNAC_EMBEDDING_MODEL: "multilingual-embedding",
    NEWSZNAC_EMBEDDING_MAX_CHARACTERS: "24000",
    NEWSZNAC_EMBEDDING_INPUT_VERSION: "embedding-v2",
    NEWSZNAC_RECOMMENDATION_SIMILARITY_THRESHOLD: "0.8",
  });
  assert.equal(config.embeddingModel, "multilingual-embedding");
  assert.equal(config.embeddingMaxCharacters, 24_000);
  assert.equal(config.embeddingInputVersion, "embedding-v2");
  assert.equal(config.recommendationSimilarityThreshold, 0.8);

  assert.throws(() => loadConfig({ NEWSZNAC_EMBEDDING_MODEL: " " }), /must not be empty/);
  assert.throws(() => loadConfig({ NEWSZNAC_EMBEDDING_MAX_CHARACTERS: "999" }), /1000 through 100000/);
  assert.throws(() => loadConfig({ NEWSZNAC_RECOMMENDATION_SIMILARITY_THRESHOLD: "1.1" }), /-1 through 1/);
});

test("loadConfig validates the local chat context limit", () => {
  assert.equal(loadConfig({ NEWSZNAC_CHAT_CONTEXT_MAX_CHARACTERS: "36000" }).chatContextMaxCharacters, 36_000);
  assert.throws(() => loadConfig({ NEWSZNAC_CHAT_CONTEXT_MAX_CHARACTERS: "999" }), /1000 through 100000/);
});
