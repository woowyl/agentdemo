# agent-mcp-demo

一个用来学习 **LLM + Agent + MCP** 工程架构的最小可运行示例：

- `apps/agent`：Agent 循环、LLM 调用、MCP Client、工具调度。
- `servers/weather`：一个独立的天气 MCP Server（返回确定性的假数据，不联网）。

两者是 **两个独立的 Node.js 进程**，只通过 MCP 协议通信，不互相 `import` 业务代码。
这是这个项目最值得保留的架构边界。

> 想快速理解实现原理、数据流向和所有配置项，看 [`ARCHITECTURE.md`](./ARCHITECTURE.md)（含架构图、时序图与配置表）。

## 目录结构

```
agent-mcp-demo/
├── apps/
│   └── agent/                  # @demo/agent
│       ├── mcp.config.json             # stdio 方式连接 MCP Server（默认）
│       ├── mcp.config.http.example.json # HTTP 方式连接（示例）
│       └── src/
│           ├── index.ts                # CLI 入口 / REPL
│           ├── runtime.ts              # Agent 循环（LLM ⇄ 工具）
│           ├── llm-provider.ts         # OpenAI 兼容 Provider 抽象
│           ├── mcp-registry.ts         # MCP Client 连接池 + 工具聚合
│           ├── config.ts               # .env 与路径解析
│           └── check-mcp.ts            # 不需要 API Key 的连通性自检
├── servers/
│   └── weather/                # @demo/weather
│       └── src/
│           ├── index.ts                # 传输选择：stdio（默认）/ --http
│           ├── server.ts               # 工具注册（McpServer）
│           └── data.ts                 # 确定性假数据
├── package.json                # workspace 统一脚本
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── .env.example
```

`packages/*` 已在 workspace 中预留，但**暂时不创建 `shared` 包**——等出现真实的跨包复用需求再加，避免为了架构而抽象。

## 快速开始

```bash
pnpm install
cp .env.example .env          # 填入 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL

# 1. 先验证 Agent 与 MCP Server 的链路（不需要 API Key）
pnpm --filter @demo/agent check:mcp

# 2. 启动交互式 Agent（它会自动以 stdio 拉起 weather server）
pnpm dev

# 或者一次性提问
pnpm dev "北京今天天气怎么样？"
```

要求 Node.js >= 20.19（用到 `process.loadEnvFile`、内置 `fetch`）。任何 OpenAI 兼容的 `/chat/completions` 端点都可以，改 `OPENAI_BASE_URL` 即可。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动 Agent（stdio 自动拉起 weather server） |
| `pnpm --filter @demo/agent check:mcp` | 只验证 MCP 链路，不调用 LLM |
| `pnpm dev:weather:http` | 单独把 weather server 跑成 HTTP 服务（默认 `127.0.0.1:8787/mcp`） |
| `pnpm build` | 编译所有包到各自的 `dist/` |
| `pnpm typecheck` | 全仓库类型检查 |
| `pnpm clean` | 删除所有 `dist/` |

REPL 内的斜杠命令：`/tools`、`/servers`、`/history`、`/clear`、`/help`、`/exit`。

## 两种传输方式

**stdio（默认）**：Agent 作为父进程按 `apps/agent/mcp.config.json` 拉起 server 子进程，日志走 stderr。
配置里的相对路径以 **workspace 根目录**（含 `pnpm-workspace.yaml` 的目录）为基准解析。

**Streamable HTTP**：server 独立部署，Agent 只做客户端。

```bash
pnpm dev:weather:http
MCP_CONFIG=apps/agent/mcp.config.http.example.json pnpm dev
```

切换传输方式时，Agent 侧的业务代码（`runtime.ts`）完全不用改——这就是把 MCP Client 收敛到 `mcp-registry.ts` 的价值。

## 一次请求的链路

```
你输入问题
  → runtime.run()            组装 messages + 工具清单
  → llm-provider.chat()      POST /chat/completions（OpenAI 兼容）
  ← assistant.tool_calls     模型要求调用工具
  → mcp-registry.callTool()  按 "server__tool" 路由到对应 MCP Client
  → weather server           执行工具，返回 content
  ← role:"tool" 消息回填进 messages
  → llm-provider.chat()      第二轮，模型基于工具结果作答
  ← 最终回复
```

约定：MCP 工具在暴露给模型时统一加 `<server>__<tool>` 前缀（例如 `weather__get_current_weather`），
避免多个 server 的同名工具冲突，同时保留路由信息。`AGENT_MAX_STEPS`（默认 8）是循环步数上限。

## 故意没有做的事

- 没有 Turborepo / Nx / 复杂构建流水线：两个包 + `pnpm -r` 足够。
- 没有 `packages/shared`：还没有真实的共享代码。
- 没有微服务部署、鉴权、观测体系。
- 工具调用是**串行**执行的，没有做并行 fan-out。

## 下一步可以演进的方向

1. 再加一个 MCP Server（比如 `servers/notes`），验证多 server 聚合与命名冲突处理。
2. `llm-provider.ts` 增加流式（SSE）输出，REPL 里逐字打印。
3. `runtime.ts` 支持同一轮内并行执行多个 tool_calls，以及重试/超时策略。
4. 会话历史持久化（SQLite 或 JSONL），支持 `--resume`。
5. 当 `packages/shared` 真的出现（例如统一日志、统一 tool schema 校验）时，再把它抽出来。
6. 包数量和构建依赖关系变复杂之后，再引入 Turborepo 做任务编排与缓存。
