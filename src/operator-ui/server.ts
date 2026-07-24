#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OperatorUiConfig, OperatorUiRuntime } from "./contracts.js";
import { ensureReportsRoot } from "./path-policy.js";
import { createOperatorApiRouter, type OperatorRouteContext } from "./routes.js";

const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const LIVE_MUSIC_VAULT_ROOT = "C:\\AIBRY\\music-vault";

export function defaultOperatorUiConfig(): OperatorUiConfig {
  return {
    repositoryRoot: REPOSITORY_ROOT,
    musicVaultRoot: LIVE_MUSIC_VAULT_ROOT,
    reportsRoot: path.join(REPOSITORY_ROOT, "reports"),
    publicRoot: path.join(REPOSITORY_ROOT, "src", "operator-ui", "public"),
    cliPath: path.join(REPOSITORY_ROOT, "dist", "src", "cli.js"),
    host: "127.0.0.1",
    port: parsePort(process.env.CATALOG_OPERATOR_PORT),
    requestBodyLimitBytes: 64 * 1024,
    commandTimeoutMs: 8 * 60 * 1000
  };
}

export async function startOperatorUi(options: {
  config?: OperatorUiConfig;
  token?: string;
  runCommand?: OperatorRouteContext["runCommand"];
} = {}): Promise<OperatorUiRuntime> {
  const config = options.config ?? defaultOperatorUiConfig();
  if (config.host !== "127.0.0.1") {
    throw new Error("Catalog Operator Console must bind to 127.0.0.1.");
  }
  await ensureReportsRoot(config.reportsRoot);
  const token = options.token ?? randomBytes(32).toString("hex");
  const startedAt = new Date().toISOString();
  const context: OperatorRouteContext = {
    config,
    token,
    startedAt,
    activities: [],
    outputLocks: new Set<string>(),
    runCommand: options.runCommand
  };
  const apiRouter = createOperatorApiRouter(context);
  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      assertLocalRequest(request);
      if (await apiRouter(request, response)) return;
      await serveStatic(config.publicRoot, request, response);
    } catch (error: unknown) {
      if (response.writableEnded) return;
      response.statusCode = 400;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(`${JSON.stringify({
        error: {
          code: "local-request-refused",
          message: error instanceof Error ? error.message : String(error),
          details: []
        }
      }, null, 2)}\n`);
    }
  });
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = config.commandTimeoutMs + 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Catalog Operator Console did not obtain a TCP address.");
  }
  const url = `http://${config.host}:${address.port}/?token=${encodeURIComponent(token)}`;
  return {
    server,
    url,
    token,
    host: config.host,
    port: address.port,
    close: () => closeServer(server)
  };
}

async function serveStatic(publicRoot: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 404;
    response.end("Not found\n");
    return;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const files: Record<string, { name: string; type: string }> = {
    "/": { name: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
    "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" }
  };
  const selected = files[url.pathname];
  if (!selected) {
    response.statusCode = 404;
    response.end("Not found\n");
    return;
  }
  const bytes = await readFile(path.join(publicRoot, selected.name));
  response.statusCode = 200;
  response.setHeader("Content-Type", selected.type);
  response.setHeader("Content-Length", bytes.byteLength);
  if (request.method === "HEAD") response.end();
  else response.end(bytes);
}

function assertLocalRequest(request: IncomingMessage): void {
  const remoteAddress = request.socket.remoteAddress ?? "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) {
    throw new Error("Only loopback clients may use the Catalog Operator Console.");
  }
  const hostHeader = request.headers.host;
  if (!hostHeader) throw new Error("A loopback Host header is required.");
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    throw new Error("Host header is invalid.");
  }
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
    throw new Error("Non-loopback Host headers are refused.");
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function parsePort(value: string | undefined): number {
  if (!value) return 4060;
  if (!/^\d+$/.test(value)) throw new Error("CATALOG_OPERATOR_PORT must be an integer from 1 to 65535.");
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("CATALOG_OPERATOR_PORT must be an integer from 1 to 65535.");
  }
  return port;
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const modulePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  startOperatorUi().then((runtime) => {
    process.stdout.write(`Catalog Operator Console: ${runtime.url}\n`);
    process.stdout.write("Loopback only. No APPLY route is available. Press Ctrl+C to stop.\n");
    const shutdown = (): void => {
      void runtime.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
