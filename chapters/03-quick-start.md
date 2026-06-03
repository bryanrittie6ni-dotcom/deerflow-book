# 第 3 章　快速上手

## 3.1　两种部署模式

DeerFlow 提供两种运行方式：

- **Docker 一键部署**（推荐）：适合快速体验和生产部署，环境一致性好。
- **本地开发模式**：适合需要修改源码的开发者，支持热重载。

无论哪种方式，第一步都是克隆仓库并生成配置文件。

## 3.2　生成配置文件

```bash
git clone https://github.com/bytedance/deer-flow.git
cd deer-flow
make config
```

`make config` 做了三件事：

1. 复制 `config.example.yaml` 为 `config.yaml`
2. 复制 `.env.example` 为 `.env`（如果不存在）
3. 复制 `frontend/.env.example` 为 `frontend/.env`（如果不存在）

如果 `config.yaml` 已存在，命令会中止并报错，防止覆盖已有配置。看一下 Makefile 中的实现：

```makefile
# 摘自 Makefile

config:
	@if [ -f config.yaml ] || [ -f config.yml ] || [ -f configure.yml ]; then \
		echo "Error: configuration file already exists. Aborting."; \
		exit 1; \
	fi
	@cp config.example.yaml config.yaml
	@test -f .env || cp .env.example .env
	@test -f frontend/.env || cp frontend/.env.example frontend/.env
```

## 3.3　配置第一个模型（以 Claude 为例）

编辑 `config.yaml`，在 `models` 部分添加你的模型配置。以 Claude 为例：

```yaml
# 摘自 config.example.yaml（取消注释并填入你的密钥）

models:
  - name: claude-3-5-sonnet
    display_name: Claude 3.5 Sonnet
    use: langchain_anthropic:ChatAnthropic
    model: claude-3-5-sonnet-20241022
    api_key: $ANTHROPIC_API_KEY
    max_tokens: 8192
    supports_vision: true
    when_thinking_enabled:
      thinking:
        type: enabled
```

然后在 `.env` 文件中设置 API 密钥：

```bash
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx
```

几个关键字段说明：

- **`use`**：LangChain 类路径，格式是 `包名:类名`。Claude 用 `langchain_anthropic:ChatAnthropic`，OpenAI 用 `langchain_openai:ChatOpenAI`。
- **`api_key: $ANTHROPIC_API_KEY`**：`$` 前缀表示从环境变量读取，这样密钥不会明文写在配置文件中。
- **`supports_vision`**：启用后 Agent 可以查看图片（通过 `view_image` 工具）。
- **`when_thinking_enabled`**：当开启 thinking 模式时传给模型的额外参数。

你也可以同时配置多个模型，DeerFlow 会使用列表中的第一个作为默认模型：

```yaml
models:
  - name: claude-3-5-sonnet
    # ... Claude 配置
  - name: deepseek-v3
    display_name: DeepSeek V3
    use: src.models.patched_deepseek:PatchedChatDeepSeek
    model: deepseek-reasoner
    api_key: $DEEPSEEK_API_KEY
    max_tokens: 16384
    supports_thinking: true
```

## 3.4　配置搜索工具

Agent 要上网搜索信息，需要配置搜索工具。DeerFlow 内置三个选项：

**Tavily（默认）**——最常用的 AI 搜索 API：

```yaml
tools:
  - name: web_search
    group: web
    use: src.community.tavily.tools:web_search_tool
    max_results: 5
```

在 `.env` 中添加：

```bash
TAVILY_API_KEY=tvly-xxxxxxxxxxxxx
```

**InfoQuest（字节跳动出品）**——支持时间范围过滤：

```yaml
tools:
  - name: web_search
    group: web
    use: src.community.infoquest.tools:web_search_tool
    search_time_range: 10
```

**网页抓取工具**同样可以选择 Jina AI 或 InfoQuest：

```yaml
tools:
  - name: web_fetch
    group: web
    use: src.community.jina_ai.tools:web_fetch_tool
    timeout: 10
```

## 3.5　Sandbox 三种模式

沙箱决定了 Agent 执行代码和操作文件的环境。这是 DeerFlow 最核心的基础设施之一。

### 模式一：Local（本地执行，适合开发）

```yaml
sandbox:
  use: src.sandbox.local:LocalSandboxProvider
```

直接在宿主机上执行命令。方便调试，但**没有隔离**——Agent 跑的 bash 命令直接在你的机器上执行。仅建议开发环境使用。

### 模式二：Docker / AIO Sandbox（推荐）

```yaml
sandbox:
  use: src.community.aio_sandbox:AioSandboxProvider
  # image: enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:latest
  # port: 8080
  # replicas: 3
```

每个任务在独立的 Docker 容器中执行，完全隔离。macOS 上还支持 Apple Container。这是大多数场景的推荐模式。

首次使用前需要拉取沙箱镜像：

```bash
make setup-sandbox
```

### 模式三：K8s Provisioner（生产环境）

```yaml
sandbox:
  use: src.community.aio_sandbox:AioSandboxProvider
  provisioner_url: http://provisioner:8002
```

通过 Provisioner 服务在 Kubernetes 集群中创建 Pod，每个 sandbox 一个独立 Pod。适合多用户、高并发的生产部署。

## 3.6　Docker 一键部署

如果选择 Docker 部署，两条命令即可启动：

```bash
make docker-init    # 拉取沙箱镜像（只需首次执行）
make docker-start   # 启动所有服务
```

`docker-start` 会根据 `config.yaml` 中的 sandbox 模式智能决定是否启动 provisioner 服务。启动后访问 http://localhost:2026 即可。

停止服务：

```bash
make docker-stop
```

查看日志：

```bash
make docker-logs           # 所有服务
make docker-logs-frontend  # 仅前端
make docker-logs-gateway   # 仅 Gateway
```

## 3.7　本地开发模式

如果你需要修改代码，使用本地开发模式：

```bash
# 1. 检查依赖（Node.js 22+、pnpm、uv、nginx）
make check

# 2. 安装依赖
make install

# 3. （可选）拉取沙箱镜像
make setup-sandbox

# 4. 启动开发服务器（支持热重载）
make dev
```

`make dev` 会同时启动四个服务：LangGraph Server、Gateway API、Frontend Dev Server 和 nginx 反向代理。同样通过 http://localhost:2026 访问。

## 3.8　嵌入式 Python 客户端

除了 Web UI，DeerFlow 还提供了一个嵌入式 Python 客户端 `DeerFlowClient`，无需启动完整的 HTTP 服务即可在 Python 脚本中直接调用 Agent：

```python
# 摘自 backend/src/client.py

from src.client import DeerFlowClient

client = DeerFlowClient()

# 一次性对话
response = client.chat("帮我调研 2026 年大模型推理优化方向", thread_id="my-research")
print(response)

# 流式输出（与 LangGraph SSE 协议对齐）
for event in client.stream("hello"):
    if event.type == "messages-tuple" and event.data.get("type") == "ai":
        print(event.data["content"])

# 查询配置
models = client.list_models()        # {"models": [...]}
skills = client.list_skills()        # {"skills": [...]}

# 技能管理
client.update_skill("web-search", enabled=True)

# 文件上传
client.upload_files("thread-1", ["./report.pdf"])
```

`DeerFlowClient` 支持多轮对话（需要配置 checkpointer），也支持自定义模型、开关 thinking 模式和子智能体：

```python
client = DeerFlowClient(
    config_path="./my-config.yaml",
    model_name="claude-3-5-sonnet",
    thinking_enabled=True,
    subagent_enabled=True,    # 启用子智能体
    plan_mode=True,           # 启用 TodoList 规划模式
)
```

这个客户端的所有返回值格式与 HTTP Gateway API 完全一致，方便在嵌入式和 HTTP 模式之间无缝切换。

## 3.9　第一次运行：调研一个技术方向

一切就绪后，打开 http://localhost:2026，输入你的第一个任务：

> 帮我调研 Rust 在 AI 推理引擎领域的应用现状，包括主要开源项目、性能对比、社区活跃度，输出一份结构化报告。

DeerFlow 会：

1. **理解任务**：Lead Agent 分析你的请求，判断需要调用哪些技能和工具
2. **加载技能**：读取 `deep-research` 技能的 SKILL.md，了解研究报告的最佳实践
3. **启动子智能体**（如果开启了 subagent 模式）：多个子智能体并行搜索不同维度的信息
4. **搜索和分析**：调用 web_search 和 web_fetch 工具获取信息
5. **生成报告**：综合所有信息，输出到 `/mnt/user-data/outputs/` 目录
6. **呈现结果**：在 UI 中展示报告内容，并提供文件下载

整个过程你可以在 UI 中实时看到 Agent 的思考过程、工具调用和中间结果。

## 3.10　工作区入口为何并发大量请求？（Network 面板对照）

首次打开 **Workspace / 聊天页** 时，浏览器开发者工具里常会看到 **多条几乎同时发出的请求**。多数是 **不同职责的并行数据加载**，并非单一接口重复「多余」调用。下面按路径对照 **本仓库前端** 的实现（部署时 `/api/langgraph` 一般由网关与 LangGraph Server 承接，与 `frontend` 里配置的基址一致）。

### 3.10.1　`/api/langgraph` 基址从哪来

未设置 `NEXT_PUBLIC_LANGGRAPH_BASE_URL` 时，浏览器端使用 **当前站点来源 + `/api/langgraph`**：

```11:26:frontend/src/core/config/index.ts
export function getLangGraphBaseURL(isMock?: boolean) {
  if (env.NEXT_PUBLIC_LANGGRAPH_BASE_URL) {
    return env.NEXT_PUBLIC_LANGGRAPH_BASE_URL;
  } else if (isMock) {
    ...
  } else {
    // LangGraph SDK requires a full URL, construct it from current origin
    if (typeof window !== "undefined") {
      return `${window.location.origin}/api/langgraph`;
    }
```

LangGraph JS SDK 的 `Client` 使用该 URL 访问 **`/threads`、`/threads/search`** 等资源。

### 3.10.2　`threads/search`：侧边栏会话列表

侧边栏「最近对话」通过 **`useThreads()`**（TanStack Query）调用 **`apiClient.threads.search`**，默认拉取最多 50 条线程（内部可按 `offset` 分页，条数不多时通常 1～2 次 search）：

```412:461:frontend/src/core/threads/hooks.ts
export function useThreads(
  params: Parameters<ThreadsClient["search"]>[0] = {
    limit: 50,
    sortBy: "updated_at",
    sortOrder: "desc",
    select: ["thread_id", "updated_at", "values"],
  },
) {
  const apiClient = getAPIClient();
  return useQuery<AgentThread[]>({
    queryKey: ["threads", "search", params],
    queryFn: async () => {
      ...
        const response = (await apiClient.threads.search<AgentThreadState>({
          ...params,
          limit: currentLimit,
          offset,
        })) as AgentThread[];
```

**同一 `search` 在短时间内出现多次** 的常见原因：**React 18 开发模式 Strict Mode 双挂载**、对话 **`onFinish` 后 `invalidateQueries({ queryKey: ["threads", "search"] })`** 触发列表刷新、或不同组件使用了不同 `queryKey` 的 `useThreads` 变体。

### 3.10.3　`threads/{thread_id}`：当前会话状态与流

进入 **`/workspace/chats/[thread_id]`** 后，**`useThreadStream` → `useStream`** 会按 LangGraph SDK 行为拉取 **线程状态 / 历史 / 重连**（例如 `reconnectOnMount: true`、`fetchStateHistory`），因此针对 **同一个 UUID** 可能看到 **多条** 线程相关请求，属 SDK 与「状态 + 流」拆分所致：

```112:118:frontend/src/core/threads/hooks.ts
  const thread = useStream<AgentThreadState>({
    client: getAPIClient(isMock),
    assistantId: "lead_agent",
    threadId: onStreamThreadId,
    reconnectOnMount: true,
    fetchStateHistory: { limit: 1 },
```

### 3.10.4　`/workspace/chats/new` 与多条页面地址

- **`/workspace/chats/new`**：Next.js 路由，表示新会话。
- 客户端 **`useThreadChat`** 为新会话生成 **UUID**；首条消息发送后 **`onStart`** 里用 **`history.replaceState`** 把地址换成 **`/workspace/chats/{thread_id}`**（避免用 Next Router 整页重挂丢状态）：

```39:42:frontend/src/app/workspace/chats/[thread_id]/page.tsx
    onStart: () => {
      setIsNewThread(false);
      // ! Important: Never use next.js router for navigation in this case, otherwise it will cause the thread to re-mount and lose all states. Use native history API instead.
      history.replaceState(null, "", `/workspace/chats/${threadId}`);
```

Network 里多条 **`/workspace/chats/...`** 还可能来自 **RSC/文档请求、Link prefetch、开发环境重复渲染** 等，不必然表示业务重复拉同一 API。

### 3.10.5　`/api/threads/{id}/suggestions`：流结束后的追问建议

输入框在 **一轮流式从 `streaming` 回到 `ready`** 后，会 **POST** 后端 **`/api/threads/${threadId}/suggestions`**，用最近若干条 human/ai 消息生成 **后续追问文案**（与 LangGraph 请求并行很正常）：

```341:349:frontend/src/components/workspace/input-box.tsx
    fetch(`${getBackendBaseURL()}/api/threads/${threadId}/suggestions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: recent,
        n: 3,
        model_name: context.model_name ?? undefined,
      }),
      signal: controller.signal,
    })
```

新会话且尚未产生完整一轮 AI 回复时，通常 **不会** 发该请求。

### 3.10.6　小结表：现象与含义

| Network 中的路径（示例） | 在本项目中的常见含义 |
|--------------------------|----------------------|
| `/api/langgraph/threads/search` | 会话列表 **`useThreads` → threads.search**，及可能的 **invalidate 刷新** |
| `/api/langgraph/threads` 或 `/threads/{id}` | LangGraph SDK：**列表/单线程状态/流相关** 等 |
| `/workspace/chats/new`、`/workspace/chats/{id}` | **Next 路由**；**replaceState** 换 URL |
| `/api/threads/{id}/suggestions` | **流结束后**拉 **追问建议** |
| 其它域名如 `/ola/v2` | **本仓库 `frontend/src` 未引用**，多为扩展、宿主埋点或第三方脚本；可用无痕/禁用扩展对比验证 |

若需 **减少请求次数**，需在理解语义的前提下做产品级取舍（例如降低列表 **invalidate** 频率、收紧 **`useStream` 历史/重连** 选项），并评估对 **断线重连、标题同步、追问体验** 的影响。

## 小结

- **两条路径**：Docker 一键部署（`make docker-init && make docker-start`）或本地开发（`make install && make dev`），统一访问 http://localhost:2026。
- **配置三步走**：`make config` 生成文件 → 编辑 `config.yaml` 配置模型 → 在 `.env` 中设置 API 密钥。
- **沙箱选择**：Local（开发调试）→ Docker/AIO Sandbox（推荐）→ K8s Provisioner（生产）。
- **嵌入式客户端** `DeerFlowClient` 可以在 Python 脚本中直接调用 Agent，无需启动 HTTP 服务，API 与 Gateway 完全对齐。
- **搜索工具**支持 Tavily、Jina、InfoQuest 等多种选择，按需配置即可。
- **工作区首屏并发请求**：`/api/langgraph` 下列表与单线程流分工、Next 路由与 **`suggestions`** 并行属常态；异常重复可从 **Strict Mode、invalidate、SDK 行为** 排查（见 **3.10**）。
