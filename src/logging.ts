export type OperationalLogLevel = "INFO" | "WARN";
export type OperationalLogValue = string | number | boolean | null | undefined;
export type OperationalLogFields = Readonly<Record<string, OperationalLogValue>>;

export interface OperationalLogger {
  info(event: string, fields?: OperationalLogFields): void;
  warn(event: string, fields?: OperationalLogFields): void;
}

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
  writer: (line: string) => unknown = (line) => process.stdout.write(line),
  clock: () => Date = () => new Date(),
): OperationalLogger {
  return {
    info: (event, fields) => { writer(formatOperationalLog("INFO", event, fields, clock())); },
    warn: (event, fields) => { writer(formatOperationalLog("WARN", event, fields, clock())); },
  };
}

function formatLocalTimestamp(timestamp: Date): string {
  const twoDigits = (value: number): string => String(value).padStart(2, "0");
  return `${twoDigits(timestamp.getMonth() + 1)}-${twoDigits(timestamp.getDate())} ${twoDigits(timestamp.getHours())}:${twoDigits(timestamp.getMinutes())}:${twoDigits(timestamp.getSeconds())}`;
}
