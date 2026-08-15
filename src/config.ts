import { isAbsolute, resolve } from "node:path";

export interface AppConfig {
  readonly databasePath: string;
  readonly lmStudioUrl: URL;
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

export function loadConfig(
  environment: ConfigEnvironment = process.env,
  workingDirectory = process.cwd(),
): AppConfig {
  const configuredPath = environment.NEWSZNAC_DATABASE_PATH ?? "data/newzsnac.sqlite";
  const databasePath = isAbsolute(configuredPath)
    ? configuredPath
    : resolve(workingDirectory, configuredPath);

  if (databasePath.trim().length === 0) {
    throw new Error("NEWSZNAC_DATABASE_PATH must not be empty");
  }

  return {
    databasePath,
    lmStudioUrl: parseLmStudioUrl(environment.NEWSZNAC_LM_STUDIO_URL),
    bindHost: parseLoopbackHost(environment.NEWSZNAC_HOST),
    port: parsePort(environment.NEWSZNAC_PORT),
  };
}
