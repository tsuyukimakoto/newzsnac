import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { loadConfig } from "./config.js";
import type { ApplicationOperations } from "./application/operations.js";
import { createApplicationOperations } from "./application/operations.js";
import { openDatabase } from "./db/database.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
};

export function createAppServer(
  publicDirectory = resolve(process.cwd(), "public"),
  operations?: ApplicationOperations,
) {
  return createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && requestUrl.pathname === "/api/items") {
      const result = operations
        ? await operations.execute(requestUrl.searchParams.has("q") ? "article.search" : "article.list",
          requestUrl.searchParams.has("q")
            ? {
                query: requestUrl.searchParams.get("q"),
                ...(requestUrl.searchParams.get("unread") === "true" ? { unread: true } : {}),
                ...(requestUrl.searchParams.has("status") ? { processingState: requestUrl.searchParams.get("status") } : {}),
              }
            : {
                ...(requestUrl.searchParams.has("sourceId") ? { sourceId: Number(requestUrl.searchParams.get("sourceId")) } : {}),
                ...(requestUrl.searchParams.get("saved") === "true" ? { saved: true } : {}),
                ...(requestUrl.searchParams.get("readLater") === "true" ? { readLater: true } : {}),
                ...(requestUrl.searchParams.get("interested") === "true" ? { interested: true } : {}),
                ...(requestUrl.searchParams.get("recommended") === "true" ? { recommended: true } : {}),
                ...(requestUrl.searchParams.get("unread") === "true" ? { unread: true } : {}),
                ...(requestUrl.searchParams.has("status") ? { processingState: requestUrl.searchParams.get("status") } : {}),
              }, "web")
        : { ok: true as const, data: [] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: result.ok ? result.data : [], nextCursor: null, newCount: 0 }));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/dashboard") {
      const [summary, sources, runtime] = operations ? await Promise.all([
        operations.execute("dashboard.summary", {}, "web"),
        operations.execute("source.list", {}, "web"),
        operations.execute("runtime.status", {}, "web"),
      ]) : [];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        summary: summary?.ok ? summary.data : { total: 0, unread: 0, saved: 0, readLater: 0, readingMinutes: 0 },
        sources: sources?.ok ? sources.data : [],
        runtime: runtime?.ok ? runtime.data : { sqlite: "unavailable", lmStudio: "unavailable" },
      }));
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/candidates") {
      const result = operations ? await operations.execute("candidate.list", {}, "web") : { ok: true as const, data: [] };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ candidates: result.ok ? result.data : [] }));
      return;
    }
    if (request.method === "POST" && requestUrl.pathname.startsWith("/api/operations/")) {
      if (!operations) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: { code: "operations_unavailable", message: "Operations are not configured" } }));
        return;
      }
      try {
        const input = await readJson(request);
        const operation = decodeURIComponent(requestUrl.pathname.slice("/api/operations/".length));
        const result = await operations.execute(operation, input, "web");
        response.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: { code: "invalid_json", message: error instanceof Error ? error.message : String(error) } }));
      }
      return;
    }

    if (request.method === "GET") {
      const pathname = requestUrl.pathname;
      const relative = pathname === "/" ? "index.html" : pathname.slice(1);
      const file = resolve(publicDirectory, relative);
      if (file.startsWith(`${publicDirectory}/`)) {
        try {
          const content = await readFile(file);
          response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
          response.end(content);
          return;
        } catch { /* Return the shared 404 below. */ }
      }
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
}

if (import.meta.filename === process.argv[1]) {
  const config = loadConfig();
  const database = openDatabase(config.databasePath);
  const server = createAppServer(resolve(process.cwd(), "public"), createApplicationOperations(database, config));
  server.on("close", () => database.close());
  const shutdown = (): void => { server.close(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(config.port, config.bindHost, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    process.stdout.write(
      `${JSON.stringify({ service: "web", status: "ready", host: config.bindHost, port })}\n`,
    );
  });
}

async function readJson(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new Error("request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) as unknown : {};
}
