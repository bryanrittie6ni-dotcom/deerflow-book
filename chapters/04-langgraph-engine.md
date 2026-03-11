# 第 4 章　LangGraph 引擎：图驱动的 Agent 编排

DeerFlow 的 Agent 系统并非手写的 while 循环，而是构建在 LangGraph 之上。LangGraph 将 Agent 的推理-行动循环抽象为一张有向图，每个节点是一个计算单元，边定义了控制流。本章解析 DeerFlow 如何利用 LangGraph 的图抽象、状态管理和持久化机制来驱动整个 Agent 系统。

## 4.1 LangGraph 是什么

LangGraph 是 LangChain 团队推出的图驱动 Agent 编排框架。它的核心抽象是 **StateGraph**——一种以状态为中心的有向图：

- **节点（Node）**：图中的计算单元，每个节点接收当前状态、执行操作、返回状态更新。
- **边（Edge）**：节点之间的连接，定义执行顺序。
- **条件边（Conditional Edge）**：根据当前状态动态决定下一个节点，实现分支逻辑。
- **状态（State）**：一个 TypedDict，在整个图的执行过程中被传递和更新。

与传统的 DAG 工作流引擎不同，LangGraph 原生支持**循环**——这正是 Agent 推理所需要的。LLM 调用工具后需要再次思考，再次调用工具……这个循环在 LangGraph 中通过条件边自然表达，无需任何特殊处理。

为什么不用简单的 while 循环来实现 Agent？因为图抽象带来了三个关键能力：第一，每个节点执行后可以自动保存状态快照，实现断点恢复；第二，图的拓扑结构可以在运行时被检查和可视化，便于调试和监控；第三，条件边的路由逻辑与节点的业务逻辑解耦，修改控制流不需要改动节点代码。这些能力对于生产级 Agent 系统至关重要。

## 4.2 DeerFlow 如何使用 LangGraph

DeerFlow 没有直接操作 `StateGraph` API 来手动添加节点和边，而是使用了 LangChain 提供的 `create_react_agent()` 工厂函数。这个函数内部自动构建了一个标准的 ReAct 图。DeerFlow 通过 `create_agent()` 对其进行了一层封装：

```python
# 简化后的调用链
def make_lead_agent(config: RunnableConfig):
    return create_agent(
        model=create_chat_model(...),
        tools=get_available_tools(...),
        middleware=_build_middlewares(config, ...),
        system_prompt=apply_prompt_template(...),
        state_schema=ThreadState,
    )
```

`create_agent()` 最终调用 `create_react_agent()`，将 DeerFlow 的模型、工具、中间件和状态模式传入。返回的是一个编译好的 LangGraph `CompiledGraph` 对象，可以直接 `invoke()` 或 `stream()` 执行。

这种设计的好处是：DeerFlow 不需要关心 ReAct 循环的具体实现细节（节点怎么连、条件怎么判断），只需要专注于**提供什么模型、什么工具、什么中间件、什么状态**。图的结构由 LangGraph 框架保证正确性。

这里有一个重要的分层：`make_lead_agent()` 是 DeerFlow 特有的工厂函数，负责从运行时配置中提取模型名称、工具组、中间件链等参数；`create_agent()` 是通用的 Agent 创建函数，负责将这些参数适配到 LangGraph 的 `create_react_agent()` 接口上。这种两层工厂的设计让 Sub-agent 也能复用 `create_agent()`，只是传入不同的参数组合。换言之，Lead Agent 和 Sub-agent 的底层图结构完全相同，区别仅在于挂载的工具和中间件不同。

## 4.3 AgentState → ThreadState

LangGraph 的 `create_react_agent()` 默认使用 `AgentState` 作为状态模式，它只包含一个 `messages` 字段用于存储对话消息。但 DeerFlow 的 Agent 需要管理远比消息更多的运行时数据。因此，`ThreadState` 继承了 `AgentState` 并扩展了 7 个自定义字段：

```python
class ThreadState(AgentState):
    sandbox: NotRequired[SandboxState | None]
    thread_data: NotRequired[ThreadDataState | None]
    title: NotRequired[str | None]
    artifacts: Annotated[list[str], merge_artifacts]
    todos: NotRequired[list | None]
    uploaded_files: NotRequired[list[dict] | None]
    viewed_images: Annotated[dict[str, ViewedImageData], merge_viewed_images]
```

各字段的职责如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `sandbox` | `SandboxState` | 沙箱环境状态，包含 `sandbox_id`，由 `SandboxMiddleware` 管理生命周期 |
| `thread_data` | `ThreadDataState` | 线程工作目录，包含 `workspace_path`、`uploads_path`、`outputs_path` 三个路径 |
| `title` | `str` | 对话标题，由 `TitleMiddleware` 在首轮交互后自动生成 |
| `artifacts` | `list[str]` | 产出物路径列表（如生成的报告文件），使用 reducer 去重合并 |
| `todos` | `list` | Plan Mode 下的任务清单，由 `TodoMiddleware` 维护 |
| `uploaded_files` | `list[dict]` | 用户上传文件的元数据，由 `UploadsMiddleware` 注入上下文 |
| `viewed_images` | `dict` | 已查看图片的缓存数据（含 base64），由 `ViewImageMiddleware` 使用 |

其中 `SandboxState` 和 `ThreadDataState` 是两个子状态类型：

```python
class SandboxState(TypedDict):
    sandbox_id: str | None

class ThreadDataState(TypedDict):
    workspace_path: str
    uploads_path: str
    outputs_path: str
```

`ThreadState` 通过 `state_schema=ThreadState` 参数传给 `create_agent()`，LangGraph 会在图执行过程中自动管理这个状态的传递和更新。

## 4.4 自定义 Reducer 函数

在 LangGraph 中，当多个节点（或中间件）对同一个状态字段进行更新时，需要一个**合并策略**来决定如何处理新旧值。这就是 Reducer 的作用。`ThreadState` 中有两个字段使用了自定义 Reducer。

**`merge_artifacts`：去重保序合并**

```python
def merge_artifacts(existing: list[str] | None, new: list[str] | None) -> list[str]:
    if existing is None:
        return new or []
    if new is None:
        return existing
    return list(dict.fromkeys(existing + new))
```

这个 Reducer 用 `dict.fromkeys()` 实现去重——利用字典键的唯一性，同时保留插入顺序（Python 3.7+ 的 dict 保证有序）。这意味着当多个工具调用各自生成了 artifact 文件路径时，最终列表既不会有重复项，也不会丢失任何一个。

**`merge_viewed_images`：带清空语义的字典合并**

```python
def merge_viewed_images(
    existing: dict[str, ViewedImageData] | None,
    new: dict[str, ViewedImageData] | None,
) -> dict[str, ViewedImageData]:
    if existing is None:
        return new or {}
    if new is None:
        return existing
    if not new:  # new == {}，空字典表示"清空所有"
        return {}
    return {**existing, **new}
```

这个 Reducer 有一个特殊约定：当 `new` 为空字典 `{}` 时，不是"没有更新"，而是"清空所有已查看的图片"。这是一种中间件清理模式——`ViewImageMiddleware` 在处理完图片并将 base64 数据注入到消息上下文后，会发送一个空字典来重置状态，避免大量图片数据在后续轮次中持续占用内存。

为什么 Reducer 如此重要？因为 LangGraph 的状态更新不是简单的覆盖。在一个包含多层中间件的系统中，如果中间件 A 写入了 `artifacts = ["a.md"]`，中间件 B 又写入了 `artifacts = ["b.md"]`，没有 Reducer 的情况下后者会覆盖前者。有了 `merge_artifacts`，两个值会被合并为 `["a.md", "b.md"]`。

## 4.5 Checkpointer：对话状态持久化

LangGraph 的 Checkpointer 机制负责在每个图节点执行后保存一份状态快照。这使得对话可以跨请求恢复——用户关闭浏览器后回来，Agent 仍然记得之前的对话上下文、沙箱状态和产出物列表。

DeerFlow 提供了两种 Checkpointer Provider，适用于不同的运行场景。

**异步 Provider（用于 FastAPI 服务端）：**

```python
# backend/src/agents/checkpointer/async_provider.py

@asynccontextmanager
async def make_checkpointer():
    checkpointer_type = get_env("CHECKPOINTER", "memory")
    if checkpointer_type == "postgres":
        async with AsyncPostgresSaver.from_conn_string(conn_string) as saver:
            await saver.setup()
            yield saver
    elif checkpointer_type == "sqlite":
        async with AsyncSqliteSaver.from_conn_string(db_path) as saver:
            await saver.setup()
            yield saver
    else:
        yield MemorySaver()
```

使用 `async with` 上下文管理器，确保数据库连接在服务生命周期结束时被正确关闭。这与 FastAPI 的 `lifespan` 事件天然匹配——在服务启动时 `yield` 之前完成初始化，在服务关闭时 `yield` 之后自动释放资源。对于 Postgres 和 SQLite 后端，`setup()` 方法会自动创建所需的数据库表结构，首次运行无需手动建表。

**同步 Provider（用于 CLI 和嵌入式客户端）：**

```python
# backend/src/agents/checkpointer/provider.py

_checkpointer = None

def get_checkpointer():
    global _checkpointer
    if _checkpointer is not None:
        return _checkpointer

    checkpointer_type = get_env("CHECKPOINTER", "memory")
    if checkpointer_type == "postgres":
        _checkpointer = PostgresSaver(conn_string)
    elif checkpointer_type == "sqlite":
        _checkpointer = SqliteSaver(db_path)
    else:
        _checkpointer = MemorySaver()
    return _checkpointer

def reset_checkpointer():
    global _checkpointer
    _checkpointer = None
```

同步 Provider 采用单例模式：全局变量 `_checkpointer` 缓存实例，避免每次调用都创建新连接。`reset_checkpointer()` 提供清理接口，主要用于测试场景中重置全局状态。为什么需要两套 Provider？因为 FastAPI 的异步运行时要求所有 I/O 操作都是非阻塞的，使用同步的数据库驱动会阻塞事件循环；而 CLI 和嵌入式客户端运行在同步上下文中，使用异步 Provider 反而增加不必要的复杂度。两套 Provider 共享相同的后端选择逻辑，只是底层驱动不同。

三种后端的适用场景：

| 后端 | 适用场景 | 持久性 |
|------|---------|--------|
| `memory` | 开发调试、单次运行 | 进程退出即丢失 |
| `sqlite` | 单机部署、嵌入式客户端 | 持久化到本地文件 |
| `postgres` | 生产环境、多实例部署 | 持久化到数据库，支持多节点共享 |

## 4.6 ReAct 循环在 LangGraph 中的实现

`create_react_agent()` 内部构建的图结构可以简化为三个核心组件：

```
┌─────────────┐
│  Agent Node  │ ← LLM 调用，生成回复或 tool_calls
└──────┬──────┘
       │
   ┌───▼────┐
   │ 条件边  │ ← 检查：response 中有 tool_calls 吗？
   └───┬────┘
      ╱ ╲
    有     无
    ↓      ↓
┌──────┐  ┌─────┐
│ Tool │  │ END │
│ Node │  └─────┘
└──┬───┘
   │
   └──→ 回到 Agent Node（循环）
```

1. **Agent Node**：将当前消息列表发送给 LLM，获取响应。如果模型决定需要调用工具，响应中会包含 `tool_calls` 字段。
2. **条件边**：检查 LLM 响应中是否存在 `tool_calls`。如果有，路由到 Tool Node；如果没有，路由到 END，结束本轮执行。
3. **Tool Node**：执行 LLM 请求的工具调用，将结果作为 `ToolMessage` 追加到消息列表，然后**回到 Agent Node**。

这就是经典的 ReAct（Reasoning + Acting）循环：思考 → 行动 → 观察 → 再思考。但与手写 while 循环不同，LangGraph 的图实现带来了额外的好处：每个节点执行后都会触发 Checkpointer 保存快照，这意味着即使在工具执行过程中服务崩溃，重启后也可以从上一个快照恢复。

需要特别说明的是，DeerFlow 的中间件管道并不是图中的独立节点，而是挂载在 Agent Node 上的拦截器。中间件在 Agent Node 执行前后运行，可以修改输入的消息列表（前置处理）或修改输出的状态更新（后置处理）。从 LangGraph 的视角看，整个中间件链和 LLM 调用是一个原子操作，共享同一个 Agent Node。这种设计避免了将中间件逻辑散落在多个图节点中，保持了图拓扑的简洁性。

## 4.7 从多节点图到单一 Lead Agent

DeerFlow 1.0（当时名为 DeerFlow）采用的是一个包含 5 个节点的复杂 StateGraph：

```
Coordinator → Planner → [Researcher, Coder] → Reporter
```

每个节点是一个专门化的 Agent，有自己独立的 system prompt 和工具集。Coordinator 负责任务分派，Planner 负责制定计划，Researcher 和 Coder 并行执行，Reporter 汇总输出。节点之间通过条件边连接，形成一个固定的多步流水线。

DeerFlow 2.0 做了一次大胆的架构简化：**将 5 个节点压缩为 1 个 Lead Agent**。原本由图结构承载的编排逻辑，被迁移到了工具集和中间件管道中：

- Coordinator 的任务分派能力 → 成为 Lead Agent 的 system prompt 中的编排指令
- Planner 的规划能力 → 成为 `TodoMiddleware` + Plan Mode
- Researcher / Coder 的专门能力 → 成为可通过 `task` 工具动态启动的 Sub-agent
- Reporter 的汇总能力 → 成为 `present_file` 内置工具

这次重构的设计哲学可以总结为一句话：**能力从图结构迁移到工具集和中间件**。图变简单了，但 Agent 的能力并没有减少——它只是从"硬编码在图拓扑中"变成了"由 LLM 在运行时动态选择"。

值得注意的是，Sub-agent 本身仍然是 LangGraph Agent。它们同样通过 `create_agent()` 创建，拥有自己的 ReAct 循环，只不过中间件链更短——只有 2 个中间件（相比 Lead Agent 的最多 11 个）。Sub-agent 不需要标题生成、对话摘要、上传文件注入等功能，因此只保留了最基本的中间件。

这种架构演进反映了 AI Agent 领域的一个重要趋势：随着大语言模型能力的增强，越来越多的编排逻辑可以交给模型自身来决策，而不是硬编码在代码中。固定的多节点流水线虽然可预测，但缺乏灵活性——模型无法跳过不必要的步骤，也无法根据任务复杂度动态调整执行路径。单一 Lead Agent 配合丰富的工具集，让模型拥有了更大的决策空间，也让系统更容易扩展新能力——只需添加新工具或新中间件，无需修改图的拓扑结构。

## 小结

- **LangGraph 的核心价值**在于将 Agent 的 ReAct 循环表达为图结构，原生支持循环、条件路由和状态持久化，避免了手写 while 循环的脆弱性。
- **ThreadState** 在 AgentState 基础上扩展了 7 个业务字段，通过 `Annotated` + Reducer 模式实现安全的状态合并，`merge_artifacts` 去重保序，`merge_viewed_images` 支持清空语义。
- **Checkpointer** 提供异步和同步两种 Provider，支持 memory/sqlite/postgres 三种后端，覆盖从开发到生产的全部场景。
- **从 5 节点图到单一 Lead Agent** 的架构演进，体现了 DeerFlow 2.0 的核心设计哲学：能力从图结构迁移到工具集和中间件，让图保持简单，让 LLM 在运行时决定如何编排。
