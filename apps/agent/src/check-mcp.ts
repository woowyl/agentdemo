import process from "node:process";
import { resolveSettings } from "./config.js";
import { McpRegistry } from "./mcp-registry.js";

/**
 * Verifies the agent <-> MCP server boundary without calling any LLM.
 * Usage: pnpm --filter @demo/agent check:mcp
 */
async function main(): Promise<void> {
  const settings = resolveSettings();
  process.stdout.write(`mcp config : ${settings.mcpConfigPath}\n`);
  process.stdout.write(`workspace  : ${settings.workspaceRoot}\n`);

  const registry = await McpRegistry.fromConfigFile(settings.mcpConfigPath, {
    workspaceRoot: settings.workspaceRoot,
    log: (message) => process.stdout.write(`[mcp] ${message}\n`),
  });

  const failures: string[] = [];
  const tools = registry.listToolSchemas();
  process.stdout.write(`servers    : ${registry.listServers().join(", ") || "(none)"}\n`);
  process.stdout.write(`tools      : ${tools.map((tool) => tool.name).join(", ") || "(none)"}\n`);

  if (tools.length === 0) {
    failures.push("no tools were discovered from the configured MCP servers");
  }

  const current = tools.find((tool) => tool.name.endsWith("__get_current_weather"));
  if (!current) {
    failures.push("expected a *__get_current_weather tool");
  } else {
    const result = await registry.callTool(current.name, { city: "北京" });
    process.stdout.write(`\ncall ${current.name} {"city":"北京"}\n${indent(result.content)}\n`);
    if (!result.ok || !result.content.includes("temperature")) {
      failures.push(`${current.name} did not return a weather payload`);
    }
  }

  const missing = await registry.callTool("weather__does_not_exist", {});
  process.stdout.write(`\ncall weather__does_not_exist -> ok=${missing.ok}\n${indent(missing.content)}\n`);
  if (missing.ok) {
    failures.push("unknown tool should report ok=false");
  }

  await registry.close();

  if (failures.length > 0) {
    process.stderr.write(`\nFAILED:\n${failures.map((item) => `  - ${item}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\nAll MCP checks passed.\n");
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
