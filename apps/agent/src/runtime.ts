import type { ChatMessage, LlmProvider } from "./llm-provider.js";
import type { McpRegistry } from "./mcp-registry.js";

export type AgentEvent =
  | { type: "step"; step: number; maxSteps: number }
  | { type: "assistant"; text: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; ok: boolean; content: string }
  | { type: "error"; message: string };

export interface AgentTurnResult {
  reply: string;
  steps: number;
  toolCalls: number;
}

export interface AgentRuntimeOptions {
  provider: LlmProvider;
  registry: McpRegistry;
  systemPrompt?: string;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
}

export const DEFAULT_SYSTEM_PROMPT = [
  "You are a concise assistant running inside a local TypeScript agent loop.",
  "Tools are provided by MCP servers and are named <server>__<tool>.",
  "Call a tool whenever the answer depends on live or external data instead of guessing.",
  "After tool results arrive, answer in the user's language and mention the data source.",
].join(" ");

export class AgentRuntime {
  readonly #provider: LlmProvider;
  readonly #registry: McpRegistry;
  readonly #maxSteps: number;
  readonly #onEvent: (event: AgentEvent) => void;
  readonly #history: ChatMessage[] = [];

  constructor(options: AgentRuntimeOptions) {
    this.#provider = options.provider;
    this.#registry = options.registry;
    this.#maxSteps = options.maxSteps ?? 8;
    this.#onEvent = options.onEvent ?? (() => {});
    this.#history.push({ role: "system", content: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT });
  }

  get history(): readonly ChatMessage[] {
    return this.#history;
  }

  reset(systemPrompt?: string): void {
    this.#history.length = 0;
    this.#history.push({ role: "system", content: systemPrompt ?? DEFAULT_SYSTEM_PROMPT });
  }

  async run(userInput: string): Promise<AgentTurnResult> {
    this.#history.push({ role: "user", content: userInput });
    const tools = this.#registry.listToolSchemas();
    let toolCalls = 0;

    for (let step = 1; step <= this.#maxSteps; step += 1) {
      this.#onEvent({ type: "step", step, maxSteps: this.#maxSteps });

      const { message } = await this.#provider.chat({ messages: this.#history, tools });
      this.#history.push(message);
      if (message.content) {
        this.#onEvent({ type: "assistant", text: message.content });
      }

      const pendingCalls = message.toolCalls ?? [];
      if (pendingCalls.length === 0) {
        return { reply: message.content, steps: step, toolCalls };
      }

      for (const call of pendingCalls) {
        toolCalls += 1;
        this.#onEvent({ type: "tool_call", name: call.name, args: call.arguments });
        const outcome = await this.#registry.callTool(call.name, call.arguments);
        this.#onEvent({
          type: "tool_result",
          name: call.name,
          ok: outcome.ok,
          content: outcome.content,
        });
        this.#history.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: outcome.ok ? outcome.content : `Tool error: ${outcome.content}`,
        });
      }
    }

    const reply = `Reached the ${this.#maxSteps}-step limit before producing a final answer.`;
    this.#history.push({ role: "assistant", content: reply });
    return { reply, steps: this.#maxSteps, toolCalls };
  }
}
