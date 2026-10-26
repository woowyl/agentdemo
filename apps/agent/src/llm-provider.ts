export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: readonly ChatMessage[];
  tools?: readonly ToolSchema[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResponse {
  message: ChatMessage;
  usage?: TokenUsage;
}

export interface LlmProvider {
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export interface OpenAiCompatibleProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  fetchImpl?: typeof globalThis.fetch;
}

interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface WireMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }> | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface WireChatCompletion {
  choices?: Array<{ message?: WireMessage }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly model: string;

  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #temperature: number | undefined;
  readonly #timeoutMs: number;
  readonly #fetchImpl: typeof globalThis.fetch;

  constructor(options: OpenAiCompatibleProviderOptions) {
    if (!options.apiKey) {
      throw new Error("An API key is required to construct the LLM provider.");
    }
    this.#apiKey = options.apiKey;
    this.#endpoint = `${(options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
    this.model = options.model ?? "gpt-4o-mini";
    this.#temperature = options.temperature;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const tools = request.tools ?? [];
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map(toWireMessage),
    };
    if (this.#temperature !== undefined) {
      body.temperature = this.#temperature;
    }
    if (tools.length > 0) {
      body.tools = tools.map(toWireTool);
      body.tool_choice = "auto";
    }

    let response: Response;
    try {
      response = await this.#fetchImpl(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new Error(`LLM request to ${this.#endpoint} failed: ${errorMessage(error)}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `LLM request failed with ${response.status} ${response.statusText}: ${detail.slice(0, 600)}`,
      );
    }

    const payload = (await response.json()) as WireChatCompletion;
    const choice = payload.choices?.[0];
    if (!choice?.message) {
      throw new Error("LLM response did not contain a message.");
    }

    const message = fromWireMessage(choice.message);
    const usage = payload.usage
      ? {
          promptTokens: payload.usage.prompt_tokens ?? 0,
          completionTokens: payload.usage.completion_tokens ?? 0,
        }
      : undefined;
    return usage ? { message, usage } : { message };
  }
}

function toWireMessage(message: ChatMessage): WireMessage {
  const wire: WireMessage = { role: message.role, content: message.content };
  if (message.role === "assistant" && message.toolCalls?.length) {
    wire.content = message.content === "" ? null : message.content;
    wire.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  if (message.role === "tool") {
    wire.tool_call_id = message.toolCallId;
    wire.name = message.name;
  }
  return wire;
}

function toWireTool(tool: ToolSchema): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function fromWireMessage(wire: WireMessage): ChatMessage {
  const role = wire.role ?? "assistant";
  const content = normalizeContent(wire.content);
  const toolCalls = (wire.tool_calls ?? [])
    .map((call, index) => {
      const name = call.function?.name;
      if (!name) {
        return undefined;
      }
      return {
        id: call.id ?? `call_${index}`,
        name,
        arguments: parseToolArguments(call.function?.arguments),
      } satisfies ToolCall;
    })
    .filter((call): call is ToolCall => call !== undefined);

  const message: ChatMessage = {
    role: role === "system" || role === "user" || role === "tool" ? role : "assistant",
    content,
  };
  if (toolCalls.length > 0) {
    message.toolCalls = toolCalls;
  }
  if (wire.tool_call_id) {
    message.toolCallId = wire.tool_call_id;
  }
  if (wire.name) {
    message.name = wire.name;
  }
  return message;
}

function normalizeContent(content: WireMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && typeof part.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw || raw.trim() === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
