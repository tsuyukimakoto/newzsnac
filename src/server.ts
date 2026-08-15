import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { loadConfig } from "./config.js";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
};

export function createAppServer(publicDirectory = resolve(process.cwd(), "public")) {
  return createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/items") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: [], nextCursor: null, newCount: 0 }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/candidates") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ candidates: [] }));
      return;
    }

    if (request.method === "GET") {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
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
  const server = createAppServer();
  server.listen(config.port, config.bindHost, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    process.stdout.write(
      `${JSON.stringify({ service: "web", status: "ready", host: config.bindHost, port })}\n`,
    );
  });
}
