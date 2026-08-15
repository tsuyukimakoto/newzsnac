import { isAbsolute, resolve } from "node:path";

export interface AppConfig {
  readonly databasePath: string;
  readonly lmStudioUrl: URL;
  readonly lmStudioModel: string;
  readonly analysisPromptVersion: string;
  readonly translationPromptVersion: string;
  readonly bindHost: "127.0.0.1" | "::1";
  readonly port: number;
}

export type ConfigEnvironment = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function parsePort(value: string | undefined): number {
  if (value === undefined) return 4317;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("NEWSZNAC_PORT must be an integer from 0 through 65535");
  }
  return port;
}

function parseLoopbackHost(value: string | undefined): "127.0.0.1" | "::1" {
  if (value === undefined || value === "127.0.0.1" || value === "localhost") {
    return "127.0.0.1";
  }
  if (value === "::1") return "::1";
  throw new Error("NEWSZNAC_HOST must be a loopback address");
}

function parseLmStudioUrl(value: string | undefined): URL {
  const url = new URL(value ?? "http://127.0.0.1:1234/v1");
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

export function loadConfig(
  environment: ConfigEnvironment = process.env,
  workingDirectory = process.cwd(),
): AppConfig {
  const configuredPath = environment.NEWSZNAC_DATABASE_PATH ?? "data/newzsnac.sqlite";
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
    lmStudioUrl: parseLmStudioUrl(environment.NEWSZNAC_LM_STUDIO_URL),
    lmStudioModel: nonEmpty(environment.NEWSZNAC_LM_STUDIO_MODEL, "qwen", "NEWSZNAC_LM_STUDIO_MODEL"),
    analysisPromptVersion: nonEmpty(environment.NEWSZNAC_ANALYSIS_PROMPT_VERSION, "analysis-v1", "NEWSZNAC_ANALYSIS_PROMPT_VERSION"),
    translationPromptVersion: nonEmpty(environment.NEWSZNAC_TRANSLATION_PROMPT_VERSION, "translate-v1", "NEWSZNAC_TRANSLATION_PROMPT_VERSION"),
    bindHost: parseLoopbackHost(environment.NEWSZNAC_HOST),
    port: parsePort(environment.NEWSZNAC_PORT),
  };
}
