export type LogLevel = "debug" | "info" | "warn" | "error";
export type OperationalLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type OperationalLogValue = string | number | boolean | null | undefined;
export type OperationalLogFields = Readonly<Record<string, OperationalLogValue>>;

export interface OperationalLogger {
  debug(event: string, fields?: OperationalLogFields): void;
  info(event: string, fields?: OperationalLogFields): void;
  warn(event: string, fields?: OperationalLogFields): void;
  error(event: string, fields?: OperationalLogFields): void;
}

export interface OperationalLoggerOptions {
  readonly minimumLevel?: LogLevel;
  readonly stdout?: (line: string) => unknown;
  readonly stderr?: (line: string) => unknown;
  readonly clock?: () => Date;
}

const LOG_LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10, info: 20, warn: 30, error: 40,
};

export function shortenLogText(value: string, maximumCharacters: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const characters = [...normalized];
  if (characters.length <= maximumCharacters) return normalized;
  if (maximumCharacters <= 0) return "";
  if (maximumCharacters === 1) return "…";
  return `${characters.slice(0, maximumCharacters - 1).join("")}…`;
}

export function formatDuration(milliseconds: number): string {
  const duration = Math.max(0, milliseconds);
  if (duration < 1_000) return `${Math.round(duration)}ms`;
  return `${(duration / 1_000).toFixed(2)}s`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatOperationalLog(
  level: OperationalLogLevel,
  event: string,
  fields: OperationalLogFields = {},
  timestamp = new Date(),
): string {
  const values = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined && entry[1] !== null)
    .map(([key, value]) => `${key}=${typeof value === "string" ? JSON.stringify(shortenLogText(value, 240)) : String(value)}`);
  return `[${formatLocalTimestamp(timestamp)}] ${level} ${event}${values.length > 0 ? ` ${values.join(" ")}` : ""}\n`;
}

export function createOperationalLogger(
  optionsOrWriter: OperationalLoggerOptions | ((line: string) => unknown) = {},
  clock: () => Date = () => new Date(),
): OperationalLogger {
  const options: OperationalLoggerOptions = typeof optionsOrWriter === "function"
    ? { stdout: optionsOrWriter, stderr: optionsOrWriter, clock }
    : optionsOrWriter;
  const minimumLevel = options.minimumLevel ?? "info";
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(line));
  const actualClock = options.clock ?? (() => new Date());
  const write = (level: LogLevel, event: string, fields?: OperationalLogFields): void => {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[minimumLevel]) return;
    const line = formatOperationalLog(level.toUpperCase() as OperationalLogLevel, event, fields, actualClock());
    (level === "debug" || level === "info" ? stdout : stderr)(line);
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

function formatLocalTimestamp(timestamp: Date): string {
  const twoDigits = (value: number): string => String(value).padStart(2, "0");
  return `${twoDigits(timestamp.getMonth() + 1)}-${twoDigits(timestamp.getDate())} ${twoDigits(timestamp.getHours())}:${twoDigits(timestamp.getMinutes())}:${twoDigits(timestamp.getSeconds())}`;
}
