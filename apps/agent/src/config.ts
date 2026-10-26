import fs from "node:fs";
import path from "node:path";

export interface AgentSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxSteps: number;
  mcpConfigPath: string;
  workspaceRoot: string;
  packageDir: string;
}

export function findWorkspaceRoot(startDir: string): string {
  let current = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}

export function loadEnvFiles(dirs: readonly string[]): void {
  const seen = new Set<string>();
  for (const dir of dirs) {
    const file = path.join(dir, ".env");
    if (seen.has(file) || !fs.existsSync(file)) {
      continue;
    }
    seen.add(file);
    try {
      process.loadEnvFile(file);
    } catch (error) {
      process.stderr.write(`[config] failed to load ${file}: ${describeError(error)}\n`);
    }
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstExistingPath(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveSettings(): AgentSettings {
  const packageDir = path.resolve(import.meta.dirname, "..");
  const workspaceRoot = findWorkspaceRoot(packageDir);
  loadEnvFiles([process.cwd(), workspaceRoot, packageDir]);

  const mcpConfigPath =
    firstExistingPath([
      process.env.MCP_CONFIG ? path.resolve(process.cwd(), process.env.MCP_CONFIG) : "",
      path.join(packageDir, "mcp.config.json"),
      path.join(process.cwd(), "mcp.config.json"),
    ]) ?? path.join(packageDir, "mcp.config.json");

  return {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    maxSteps: toPositiveInt(process.env.AGENT_MAX_STEPS, 8),
    mcpConfigPath,
    workspaceRoot,
    packageDir,
  };
}
