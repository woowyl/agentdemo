import process from "node:process";
import readline from "node:readline/promises";
import { describeError, resolveSettings } from "./config.js";
import { OpenAiCompatibleProvider } from "./llm-provider.js";
import { McpRegistry } from "./mcp-registry.js";
import { AgentRuntime, type AgentEvent } from "./runtime.js";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

function paint(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

const dim = (text: string): string => paint("2", text);
const bold = (text: string): string => paint("1", text);
const green = (text: string): string => paint("32", text);
const cyan = (text: string): string => paint("36", text);
const yellow = (text: string): string => paint("33", text);
const red = (text: string): string => paint("31", text);

function truncate(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function printEvent(event: AgentEvent): void {
  switch (event.type) {
    case "step":
      process.stderr.write(dim(`  [step ${event.step}/${event.maxSteps}]\n`));
      break;
    case "tool_call":
      process.stderr.write(yellow(`  → tool ${event.name} ${JSON.stringify(event.args)}\n`));
      break;
    case "tool_result":
      process.stderr.write(
        dim(`  ← ${event.ok ? "ok" : "error"} ${event.name}: ${truncate(event.content)}\n`),
      );
      break;
    case "assistant":
      break;
    case "error":
      process.stderr.write(red(`  ! ${event.message}\n`));
      break;
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "",
      bold("commands"),
      "  /tools     list MCP tools exposed to the model",
      "  /servers   list connected MCP servers",
      "  /history   show the raw message history sent to the model",
      "  /clear     reset the conversation",
      "  /help      show this help",
      "  /exit      quit (Ctrl-C also works)",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const settings = resolveSettings();

  if (!settings.apiKey) {
    process.stderr.write(
      [
        red("missing OPENAI_API_KEY."),
        "",
        `Copy ${settings.workspaceRoot}/.env.example to ${settings.workspaceRoot}/.env and fill in:`,
        "  OPENAI_API_KEY, OPENAI_BASE_URL (any OpenAI-compatible endpoint), OPENAI_MODEL",
        "",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const registry = await McpRegistry.fromConfigFile(settings.mcpConfigPath, {
    workspaceRoot: settings.workspaceRoot,
    log: (message) => process.stderr.write(dim(`[mcp] ${message}\n`)),
  });

  let shuttingDown = false;
  const shutdown = async (exitCode: number): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await registry.close();
    process.exit(exitCode);
  };
  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));

  try {
    const provider = new OpenAiCompatibleProvider({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
    });

    const agent = new AgentRuntime({
      provider,
      registry,
      maxSteps: settings.maxSteps,
      onEvent: printEvent,
    });

    const tools = registry.listToolSchemas();
    const prompt = process.argv.slice(2).join(" ").trim();
    if (prompt) {
      const result = await agent.run(prompt);
      process.stdout.write(`${result.reply}\n`);
      return;
    }

    process.stdout.write(
      [
        "",
        bold("agent-mcp-demo"),
        dim(`  model      ${provider.model}`),
        dim(`  endpoint   ${settings.baseUrl}`),
        dim(`  mcp config ${settings.mcpConfigPath}`),
        dim(`  servers    ${registry.listServers().join(", ") || "(none)"}`),
        dim(`  tools      ${tools.map((tool) => tool.name).join(", ") || "(none)"}`),
        dim("  type /help for commands"),
        "",
      ].join("\n"),
    );

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      let input: string;
      try {
        input = await rl.question(green("you › "));
      } catch {
        break;
      }
      const text = input.trim();
      if (!text) {
        continue;
      }
      if (text === "/exit" || text === "/quit" || text === "exit" || text === "quit") {
        break;
      }
      if (text.startsWith("/")) {
        handleCommand(text, agent, registry);
        continue;
      }
      try {
        const result = await agent.run(text);
        if (result.reply) {
          process.stdout.write(`${cyan("agent ›")} ${result.reply}\n\n`);
        }
      } catch (error) {
        process.stderr.write(red(`error: ${describeError(error)}\n`));
      }
    }
    rl.close();
  } finally {
    await registry.close();
  }
}

function handleCommand(command: string, agent: AgentRuntime, registry: McpRegistry): void {
  const [name, ...rest] = command.split(/\s+/);
  switch (name) {
    case "/help":
      printHelp();
      break;
    case "/servers":
      process.stdout.write(`${registry.listServers().join("\n") || "(none)"}\n`);
      break;
    case "/tools": {
      const tools = registry.listToolSchemas();
      if (tools.length === 0) {
        process.stdout.write("(no tools registered)\n");
        break;
      }
      for (const tool of tools) {
        process.stdout.write(`  ${bold(tool.name)}\n    ${dim(truncate(tool.description, 160))}\n`);
      }
      break;
    }
    case "/history":
      process.stdout.write(`${JSON.stringify(agent.history, null, 2)}\n`);
      break;
    case "/clear":
      agent.reset();
      process.stdout.write(dim("conversation cleared\n"));
      break;
    default:
      process.stdout.write(
        `unknown command "${rest.length ? `${name} ${rest.join(" ")}` : name}". type /help\n`,
      );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(red(`fatal: ${describeError(error)}\n`));
  process.exitCode = 1;
});
