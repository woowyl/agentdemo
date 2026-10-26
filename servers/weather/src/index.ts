import http from "node:http";
import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createWeatherServer } from "./server.js";

const MCP_PATH = "/mcp";

function wantsHttp(): boolean {
  return (
    process.argv.includes("--http") ||
    process.argv.includes("--transport=http") ||
    process.env.WEATHER_TRANSPORT === "http"
  );
}

async function runStdio(): Promise<void> {
  const server = createWeatherServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write("[weather] MCP server ready on stdio\n");
}

async function runHttp(): Promise<void> {
  const host = process.env.WEATHER_HTTP_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.WEATHER_HTTP_PORT ?? "8787", 10);

  const httpServer = http.createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      process.stderr.write(`[weather] request failed: ${describe(error)}\n`);
      if (!res.headersSent) {
        sendJson(res, 500, internalError(describe(error)));
      }
    });
  });

  httpServer.listen(port, host, () => {
    process.stderr.write(`[weather] MCP server ready on http://${host}:${port}${MCP_PATH}\n`);
  });

  const shutdown = (): void => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== MCP_PATH) {
    sendJson(res, 404, internalError(`Unknown path ${url.pathname}`));
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, internalError("Only POST is supported in stateless mode"));
    return;
  }

  const raw = await readBody(req);
  let parsed: JSONRPCMessage | undefined;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw.toString("utf8")) as JSONRPCMessage;
    } catch {
      sendJson(res, 400, internalError("Invalid JSON body"));
      return;
    }
  }

  const server = createWeatherServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsed);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function internalError(message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: null, error: { code: -32603, message } };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  if (wantsHttp()) {
    await runHttp();
    return;
  }
  await runStdio();
}

main().catch((error: unknown) => {
  process.stderr.write(`[weather] fatal: ${describe(error)}\n`);
  process.exitCode = 1;
});
