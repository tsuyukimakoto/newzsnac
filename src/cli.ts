import type { ApplicationOperations, OperationCaller } from "./application/operations.js";
import { createApplicationOperations } from "./application/operations.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";

export async function runCli(args: readonly string[], providedOperations?: ApplicationOperations): Promise<number> {
  const callerIndex = args.indexOf("--caller");
  const callerValue = callerIndex >= 0 ? args[callerIndex + 1] : "cli";
  if (callerValue !== "cli" && callerValue !== "openclaw") {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "invalid_caller", message: "caller must be cli or openclaw" } })}\n`);
    return 2;
  }
  const filtered = callerIndex >= 0 ? args.filter((_value, index) => index !== callerIndex && index !== callerIndex + 1) : [...args];
  const [command, inputJson = "{}"] = filtered;
  if (command === "health") {
    process.stdout.write(`${JSON.stringify({ service: "cli", status: "ok" })}\n`);
    return 0;
  }
  if (!command) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: "missing_operation", message: "operation name is required" } })}\n`);
    return 2;
  }
  let input: unknown;
  try { input = JSON.parse(inputJson) as unknown; }
  catch {
    process.stderr.write(`${JSON.stringify({ ok: false, operation: command, error: { code: "invalid_json", message: "input must be valid JSON" } })}\n`);
    return 2;
  }
  const config = loadConfig();
  const database = providedOperations ? null : openDatabase(config.databasePath);
  try {
    const operations = providedOperations ?? createApplicationOperations(database!, config);
    const result = await operations.execute(command, input, callerValue as OperationCaller);
    const output = `${JSON.stringify(result)}\n`;
    (result.ok ? process.stdout : process.stderr).write(output);
    return result.ok ? 0 : 2;
  } finally { database?.close(); }
}

if (import.meta.filename === process.argv[1]) {
  process.exitCode = await runCli(process.argv.slice(2));
}
