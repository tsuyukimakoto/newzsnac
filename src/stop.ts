import { loadConfig } from "./config.js";
import { stopRecordedRuntime } from "./runtime.js";

try {
  const status = await stopRecordedRuntime(loadConfig().pidPath, process.cwd());
  process.stdout.write(`${JSON.stringify({ service: "newzsnac", status })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
