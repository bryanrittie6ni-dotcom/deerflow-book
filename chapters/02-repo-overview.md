# 第 2 章　仓库全景与技术栈

## 2.1　目录结构

拿到 DeerFlow 的源码，第一件事是看目录结构。整个仓库的布局清晰、职责分明：

```
deer-flow/
├── backend/                  # 后端核心（Python）
│   ├── src/
│   │   ├── agents/           # Agent 定义（lead_agent、middlewares）
│   │   ├── channels/         # IM 频道集成（Telegram、Slack、飞书）
│   │   ├── client.py         # 嵌入式 Python 客户端
│   │   ├── community/        # 社区贡献的工具和沙箱实现
│   │   ├── config/           # 配置加载和解析
│   │   ├── gateway/          # Gateway API（FastAPI）
│   │   ├── mcp/              # MCP Server 集成
│   │   ├── models/           # 模型封装和适配
│   │   ├── reflection/       # 反思机制
│   │   ├── sandbox/          # 沙箱执行引擎
│   │   ├── skills/           # Skills 加载器
│   │   ├── subagents/        # 子智能体管理
│   │   ├── tools/            # 内置工具（搜索、文件、bash）
│   │   └── utils/            # 通用工具
│   └── pyproject.toml        # Python 依赖定义
├── frontend/                 # 前端（Next.js + React）
│   ├── src/                  # 前端源码
│   └── package.json          # Node 依赖定义
├── skills/                   # 技能定义目录
│   └── public/               # 内置技能
│       ├── deep-research/    # 深度研究
│       ├── data-analysis/    # 数据分析
│       ├── ppt-generation/   # PPT 生成
│       ├── web-design-guidelines/ # 网页设计
│       ├── image-generation/ # 图片生成
│       ├── video-generation/ # 视频生成
│       ├── consulting-analysis/   # 咨询分析
│       ├── chart-visualization/   # 图表可视化
│       ├── claude-to-deerflow/    # Claude Code 集成
│       └── ...               # 更多技能
├── docker/                   # Docker 配置和 nginx
├── scripts/                  # 启动、检查、清理脚本
├── config.example.yaml       # 配置模板
├── extensions_config.example.json  # MCP 和 Skills 状态配置模板
└── Makefile                  # 统一入口命令
```

几个值得注意的设计决策：

1. **backend 和 frontend 完全分离**——后端是纯 Python，前端是纯 Next.js，通过 API 和 SSE 通信。
2. **skills 独立于 backend**——技能是 Markdown 文件，不是代码。这意味着非开发者也可以编写和贡献技能。
3. **community 目录**——社区贡献的工具（Tavily、Jina、InfoQuest）和沙箱实现（AIO Sandbox）放在 `src/community/` 下，与核心代码隔离。

## 2.2　核心依赖

打开 `backend/pyproject.toml`，DeerFlow 的技术栈一目了然：

```toml
# 摘自 backend/pyproject.toml

[project]
name = "deer-flow"
version = "0.1.0"
description = "LangGraph-based AI agent system with sandbox execution capabilities"
requires-python = ">=3.12"
dependencies = [
    "agent-sandbox>=0.0.19",
    "fastapi>=0.115.0",
    "httpx>=0.28.0",
    "kubernetes>=30.0.0",
    "langchain>=1.2.3",
    "langchain-anthropic>=1.3.4",
    "langchain-deepseek>=1.0.1",
    "langchain-openai>=1.1.7",
    "langgraph>=1.0.6",
    "langgraph-api>=0.7.0,<0.8.0",
    "langgraph-runtime-inmem>=0.22.1",
    "pydantic>=2.12.5",
    "sse-starlette>=2.1.0",
    "tavily-python>=0.7.17",
    "uvicorn[standard]>=0.34.0",
    "langchain-google-genai>=4.2.1",
    "slack-sdk>=3.33.0",
    "python-telegram-bot>=21.0",
    # ...更多依赖
]
```

逐层拆解这些依赖的角色：

### LangGraph：编排引擎

DeerFlow 的 Agent 编排建立在 **LangGraph** 之上。LangGraph 提供了有状态的、可持久化的 Agent 运行时：

- `langgraph>=1.0.6`：核心图编排引擎
- `langgraph-api>=0.7.0`：LangGraph Server API
- `langgraph-runtime-inmem>=0.22.1`：内存运行时
- `langgraph-checkpoint-sqlite>=3.0.3`：SQLite 持久化

DeerFlow 用 LangGraph 的 `create_agent` 创建 Lead Agent，用 middleware 链处理上下文摘要、记忆注入、子智能体限流等横切关注点。

### LangChain：模型和工具适配层

LangChain 系列库负责统一不同模型提供商的接口：

- `langchain>=1.2.3`：核心抽象
- `langchain-anthropic>=1.3.4`：Claude 系列
- `langchain-openai>=1.1.7`：OpenAI / 兼容 API
- `langchain-deepseek>=1.0.1`：DeepSeek
- `langchain-google-genai>=4.2.1`：Gemini
- `langchain-mcp-adapters>=0.1.0`：MCP 工具适配

### FastAPI + SSE：API 层

- `fastapi>=0.115.0`：Gateway API 框架
- `sse-starlette>=2.1.0`：Server-Sent Events 流式推送
- `uvicorn[standard]>=0.34.0`：ASGI 服务器

### 沙箱和执行环境

- `agent-sandbox>=0.0.19`：沙箱抽象
- `kubernetes>=30.0.0`：K8s 集成（生产环境 Pod 管理）

### IM 频道集成

- `slack-sdk>=3.33.0`：Slack Socket Mode
- `python-telegram-bot>=21.0`：Telegram Bot API
- `lark-oapi>=1.4.0`：飞书 / Lark WebSocket

## 2.3　前端技术栈

前端采用 **Next.js + React**，实现实时流式 UI：

- **Next.js**：全栈 React 框架，提供路由和 SSR
- **pnpm**：包管理器（仓库使用 pnpm workspace）
- **实时流式渲染**：通过 SSE 接收后端的 Agent 执行事件，增量渲染 AI 回复、工具调用、文件产出

前端通过 nginx 反向代理统一暴露在 `localhost:2026`，API 请求转发到 Gateway（8001）和 LangGraph Server（2024）。

## 2.4　配置体系

DeerFlow 的配置分为三层：

**第一层：`config.yaml`** —— 核心配置文件，包含模型定义、工具配置、沙箱模式、子智能体超时、Skills 路径、摘要策略、记忆系统等。这是你部署 DeerFlow 时必须编辑的文件。

**第二层：`extensions_config.json`** —— MCP Server 和 Skills 启用状态。这个文件允许运行时动态开关 MCP 服务和技能，不需要重启。

**第三层：`.env`** —— API 密钥和敏感配置。DeerFlow 的 `config.yaml` 支持 `$ENV_VAR` 语法引用环境变量，所以密钥不需要写在配置文件里。

## 2.5　支持的模型

DeerFlow 是模型无关的（model-agnostic），支持任何实现 OpenAI 兼容 API 的模型。配置文件中提供了以下模型的示例：

| 模型 | LangChain 适配类 | 特殊能力 |
|------|-----------------|---------|
| Claude 3.5 Sonnet | `langchain_anthropic:ChatAnthropic` | Thinking、Vision |
| GPT-4 | `langchain_openai:ChatOpenAI` | Vision |
| Gemini 2.5 Pro | `langchain_google_genai:ChatGoogleGenerativeAI` | Vision |
| DeepSeek V3 | `src.models.patched_deepseek:PatchedChatDeepSeek` | Thinking |
| 豆包 Seed 1.8 | `src.models.patched_deepseek:PatchedChatDeepSeek` | Thinking、Vision |
| Kimi K2.5 | `src.models.patched_deepseek:PatchedChatDeepSeek` | Thinking、Vision |
| OpenAI 兼容 | `langchain_openai:ChatOpenAI` | 取决于提供商 |

DeerFlow 在最佳实践中推荐的模型特性包括：长上下文窗口（100K+ tokens）、推理能力（reasoning）、多模态输入、可靠的工具调用（tool-use）。

## 2.6　运行时架构

一个运行中的 DeerFlow 实例由四个服务组成：

```
用户浏览器
    │
    ▼
  nginx (端口 2026)           ← 反向代理，统一入口
    ├── /api/gateway/* ──→ Gateway API (端口 8001)    ← FastAPI，管理接口
    ├── /api/langgraph/* ──→ LangGraph Server (端口 2024) ← Agent 运行时
    └── /* ──────────────→ Frontend (端口 3000)       ← Next.js UI
```

Gateway API 负责配置管理、文件上传、技能管理等"管控面"操作。LangGraph Server 负责 Agent 的实际执行——接收用户消息、运行 Lead Agent、调度子智能体、流式返回结果。

## 小结

- **目录结构清晰**：backend（Python Agent 引擎）/ frontend（Next.js 流式 UI）/ skills（Markdown 技能定义）/ docker（容器化部署）四大模块。
- **核心引擎是 LangGraph + LangChain**：LangGraph 负责有状态的 Agent 编排，LangChain 负责模型和工具的统一抽象。
- **配置三层分离**：`config.yaml`（核心配置）+ `extensions_config.json`（运行时开关）+ `.env`（密钥）。
- **模型无关**：通过 LangChain 适配层支持 Claude / GPT / Gemini / DeepSeek / 豆包 / Kimi 等，任何 OpenAI 兼容 API 均可接入。
- **四服务架构**：nginx + Frontend + Gateway + LangGraph Server，通过 SSE 实现实时流式交互。
