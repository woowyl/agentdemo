import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describeError } from "./config.js";
import type { ToolSchema } from "./llm-provider.js";

export const TOOL_NAME_SEPARATOR = "__";

interface SharedServerConfig {
  disabled?: boolean;
}

export interface StdioServerConfig extends SharedServerConfig {
  transport?: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface HttpServerConfig extends SharedServerConfig {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

export interface ToolCallOutcome {
  ok: boolean;
  content: string;
}

interface RegisteredTool {
  serverName: string;
  tool: Tool;
}

export interface McpRegistryOptions {
  workspaceRoot: string;
  log?: (message: string) => void;
}

export class McpRegistry {
  readonly #workspaceRoot: string;
  readonly #log: (message: string) => void;
  readonly #clients = new Map<string, Client>();
  readonly #tools = new Map<string, RegisteredTool>();

  constructor(options: McpRegistryOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#log = options.log ?? (() => {});
  }

  static async fromConfigFile(
    configFile: string,
    options: McpRegistryOptions,
  ): Promise<McpRegistry> {
    const registry = new McpRegistry(options);
    await registry.loadConfigFile(configFile);
    return registry;
  }

  async loadConfigFile(configFile: string): Promise<void> {
    if (!fs.existsSync(configFile)) {
      this.#log(`config file not found, running without MCP tools: ${configFile}`);
      return;
    }
    const raw = await fs.promises.readFile(configFile, "utf8");
    let parsed: McpConfigFile;
    try {
      parsed = JSON.parse(raw) as McpConfigFile;
    } catch (error) {
      throw new Error(`Invalid MCP config ${configFile}: ${describeError(error)}`);
    }

    const entries = Object.entries(parsed.mcpServers ?? {});
    for (const [name, config] of entries) {
      if (config.disabled === true) {
        this.#log(`skipping disabled MCP server: ${name}`);
        continue;
      }
      try {
        await this.connect(name, config);
      } catch (error) {
        this.#log(`failed to connect MCP server "${name}": ${describeError(error)}`);
      }
    }
  }

  async connect(serverName: string, config: McpServerConfig): Promise<void> {
    if (this.#clients.has(serverName)) {
      throw new Error(`MCP server "${serverName}" is already connected.`);
    }
    const client = new Client({ name: "@demo/agent", version: "0.1.0" });
    const transport =
      config.transport === "http"
        ? new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: config.headers ? { headers: config.headers } : undefined,
          })
        : new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            cwd: this.#resolvePath(config.cwd ?? this.#workspaceRoot),
            env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
            stderr: "inherit",
          });

    await client.connect(transport);
    this.#clients.set(serverName, client);

    const { tools } = await client.listTools();
    for (const tool of tools) {
      this.#tools.set(`${serverName}${TOOL_NAME_SEPARATOR}${tool.name}`, {
        serverName,
        tool,
      });
    }
    this.#log(
      `connected MCP server "${serverName}" (${config.transport === "http" ? config.url : config.command}) with ${tools.length} tool(s)`,
    );
  }

  listServers(): string[] {
    return [...this.#clients.keys()];
  }

  listToolSchemas(): ToolSchema[] {
    return [...this.#tools.entries()].map(([qualifiedName, registered]) => ({
      name: qualifiedName,
      description: registered.tool.description ?? registered.tool.name,
      parameters: toJsonObject(registered.tool.inputSchema),
    }));
  }

  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    const separatorIndex = qualifiedName.indexOf(TOOL_NAME_SEPARATOR);
    if (separatorIndex <= 0) {
      return {
        ok: false,
        content: `Unknown tool "${qualifiedName}". Expected the format <server>${TOOL_NAME_SEPARATOR}<tool>.`,
      };
    }
    const serverName = qualifiedName.slice(0, separatorIndex);
    const toolName = qualifiedName.slice(separatorIndex + TOOL_NAME_SEPARATOR.length);
    const registered = this.#tools.get(qualifiedName);
    const client = this.#clients.get(serverName);
    if (!registered || !client) {
      return {
        ok: false,
        content: `Tool "${qualifiedName}" is not available. Known tools: ${this.listToolSchemas()
          .map((tool) => tool.name)
          .join(", ") || "(none)"}`,
      };
    }

    try {
      const result = (await client.callTool({ name: toolName, arguments: args })) as {
        content?: unknown;
        isError?: boolean;
      };
      const content = renderToolContent(result.content);
      const isError = result.isError === true;
      return {
        ok: !isError,
        content: content === "" ? (isError ? "Tool returned an empty error." : "ok") : content,
      };
    } catch (error) {
      return { ok: false, content: describeError(error) };
    }
  }

  async close(): Promise<void> {
    const clients = [...this.#clients.entries()];
    this.#clients.clear();
    this.#tools.clear();
    await Promise.all(
      clients.map(async ([name, client]) => {
        try {
          await client.close();
        } catch (error) {
          this.#log(`error while closing MCP server "${name}": ${describeError(error)}`);
        }
      }),
    );
  }

  #resolvePath(target: string): string {
    return path.isAbsolute(target) ? target : path.resolve(this.#workspaceRoot, target);
  }
}

function toJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

function renderToolContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const block = item as {
      type?: string;
      text?: string;
      mimeType?: string;
      resource?: { text?: string; uri?: string };
      uri?: string;
    };
    switch (block.type) {
      case "text":
        parts.push(block.text ?? "");
        break;
      case "image":
        parts.push(`[image ${block.mimeType ?? "unknown"}]`);
        break;
      case "audio":
        parts.push(`[audio ${block.mimeType ?? "unknown"}]`);
        break;
      case "resource":
        parts.push(block.resource?.text ?? `[resource ${block.resource?.uri ?? "unknown"}]`);
        break;
      case "resource_link":
        parts.push(`[resource link ${block.uri ?? "unknown"}]`);
        break;
      default:
        parts.push(JSON.stringify(item));
    }
  }
  return parts.join("\n").trim();
}
