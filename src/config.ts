import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";

export interface AppConfig {
  readonly databasePath: string;
  readonly lmStudioUrl: URL;
  readonly lmStudioModel: string;
  readonly embeddingModel: string | null;
  readonly embeddingMaxCharacters: number;
  readonly embeddingInputVersion: string;
  readonly recommendationSimilarityThreshold: number;
  readonly analysisPromptVersion: string;
  readonly translationPromptVersion: string;
  readonly chatContextMaxCharacters: number;
  readonly bindHost: "127.0.0.1" | "::1";
  readonly port: number;
}

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

export const CONFIG_DEFAULTS = Object.freeze({
  databasePath: "data/newzsnac.sqlite",
  lmStudioUrl: "http://127.0.0.1:1234/v1",
  lmStudioModel: "qwen",
  embeddingModel: null,
  embeddingMaxCharacters: 12_000,
  embeddingInputVersion: "embedding-v1",
  recommendationSimilarityThreshold: 0.86,
  analysisPromptVersion: "analysis-v2",
  translationPromptVersion: "translate-v1",
  chatContextMaxCharacters: 24_000,
  bindHost: "127.0.0.1" as const,
  port: 4317,
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function parsePort(value: string | undefined): number {
  if (value === undefined) return CONFIG_DEFAULTS.port;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("NEWSZNAC_PORT must be an integer from 0 through 65535");
  }
  return port;
}

function parseLoopbackHost(value: string | undefined): "127.0.0.1" | "::1" {
  if (value === undefined || value === "127.0.0.1" || value === "localhost") {
    return CONFIG_DEFAULTS.bindHost;
  }
  if (value === "::1") return "::1";
  throw new Error("NEWSZNAC_HOST must be a loopback address");
}

function parseLmStudioUrl(value: string | undefined): URL {
  const url = new URL(value ?? CONFIG_DEFAULTS.lmStudioUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NEWSZNAC_LM_STUDIO_URL must use HTTP or HTTPS");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("NEWSZNAC_LM_STUDIO_URL must point to this computer");
  }
  return url;
}

function nonEmpty(value: string | undefined, fallback: string, name: string): string {
  const actual = value ?? fallback;
  if (!actual.trim()) throw new Error(`${name} must not be empty`);
  return actual.trim();
}

function optionalNonEmpty(value: string | undefined, name: string): string | null {
  if (value === undefined) return null;
  if (!value.trim()) throw new Error(`${name} must not be empty when set`);
  return value.trim();
}

function integerInRange(value: string | undefined, fallback: number, name: string, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function numberInRange(value: string | undefined, fallback: number, name: string, minimum: number, maximum: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number from ${minimum} through ${maximum}`);
  }
  return parsed;
}

export function loadConfig(
  environment: ConfigEnvironment | undefined = undefined,
  workingDirectory = process.cwd(),
): AppConfig {
  const actualEnvironment = environment ?? {
    ...readDotEnv(workingDirectory),
    ...process.env,
  };
  const configuredPath = actualEnvironment.NEWSZNAC_DATABASE_PATH ?? CONFIG_DEFAULTS.databasePath;
  const databasePath = configuredPath === ":memory:"
    ? configuredPath
    : isAbsolute(configuredPath)
    ? configuredPath
    : resolve(workingDirectory, configuredPath);

  if (databasePath.trim().length === 0) {
    throw new Error("NEWSZNAC_DATABASE_PATH must not be empty");
  }

  return {
    databasePath,
    lmStudioUrl: parseLmStudioUrl(actualEnvironment.NEWSZNAC_LM_STUDIO_URL),
    lmStudioModel: nonEmpty(actualEnvironment.NEWSZNAC_LM_STUDIO_MODEL, CONFIG_DEFAULTS.lmStudioModel, "NEWSZNAC_LM_STUDIO_MODEL"),
    embeddingModel: optionalNonEmpty(actualEnvironment.NEWSZNAC_EMBEDDING_MODEL, "NEWSZNAC_EMBEDDING_MODEL"),
    embeddingMaxCharacters: integerInRange(actualEnvironment.NEWSZNAC_EMBEDDING_MAX_CHARACTERS, CONFIG_DEFAULTS.embeddingMaxCharacters, "NEWSZNAC_EMBEDDING_MAX_CHARACTERS", 1_000, 100_000),
    embeddingInputVersion: nonEmpty(actualEnvironment.NEWSZNAC_EMBEDDING_INPUT_VERSION, CONFIG_DEFAULTS.embeddingInputVersion, "NEWSZNAC_EMBEDDING_INPUT_VERSION"),
    recommendationSimilarityThreshold: numberInRange(actualEnvironment.NEWSZNAC_RECOMMENDATION_SIMILARITY_THRESHOLD, CONFIG_DEFAULTS.recommendationSimilarityThreshold, "NEWSZNAC_RECOMMENDATION_SIMILARITY_THRESHOLD", -1, 1),
    analysisPromptVersion: nonEmpty(actualEnvironment.NEWSZNAC_ANALYSIS_PROMPT_VERSION, CONFIG_DEFAULTS.analysisPromptVersion, "NEWSZNAC_ANALYSIS_PROMPT_VERSION"),
    translationPromptVersion: nonEmpty(actualEnvironment.NEWSZNAC_TRANSLATION_PROMPT_VERSION, CONFIG_DEFAULTS.translationPromptVersion, "NEWSZNAC_TRANSLATION_PROMPT_VERSION"),
    chatContextMaxCharacters: integerInRange(actualEnvironment.NEWSZNAC_CHAT_CONTEXT_MAX_CHARACTERS, CONFIG_DEFAULTS.chatContextMaxCharacters, "NEWSZNAC_CHAT_CONTEXT_MAX_CHARACTERS", 1_000, 100_000),
    bindHost: parseLoopbackHost(actualEnvironment.NEWSZNAC_HOST),
    port: parsePort(actualEnvironment.NEWSZNAC_PORT),
  };
}

function readDotEnv(workingDirectory: string): ConfigEnvironment {
  try {
    return parseEnv(readFileSync(resolve(workingDirectory, ".env"), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}
