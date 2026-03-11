# 第 8 章　Sub-Agent 架构总览

当一个 AI Agent 面对的任务足够复杂时，单线程逐步执行的效率就会成为瓶颈。DeerFlow 的 Sub-Agent 系统正是为此而设计：Lead Agent 扮演"指挥官"角色，将复杂任务拆解为多个独立子任务，交由专门的 Sub-Agent 并行执行，最后综合结果交付给用户。

本章将从整体架构出发，完整梳理 Sub-Agent 的设计理念、API 接口、类型体系以及与 Lead Agent 之间的协作关系。

## 8.1 Lead Agent 与 Sub-Agent 的关系

在 DeerFlow 中，Lead Agent 是用户直接交互的主 Agent。它拥有完整的 Middleware 栈、澄清机制、Skill 系统等能力。当遇到可并行分解的复杂任务时，Lead Agent 通过调用 `task` 工具创建 Sub-Agent。

两者的关系可以概括为：

- **Lead Agent 是编排者**：负责任务分解、批次规划、结果综合
- **Sub-Agent 是执行者**：在隔离上下文中自主完成单个子任务
- **不可嵌套**：Sub-Agent 无法再创建 Sub-Agent，`task` 工具在子 Agent 的工具列表中被显式排除

这种单层委派模型避免了递归嵌套带来的复杂度和资源消耗问题。

## 8.2 task 工具的完整 API

`task` 是 Lead Agent 创建 Sub-Agent 的唯一入口，定义在 `task_tool.py` 中：

```python
@tool("task", parse_docstring=True)
def task_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    prompt: str,
    subagent_type: Literal["general-purpose", "bash"],
    tool_call_id: Annotated[str, InjectedToolCallId],
    max_turns: int | None = None,
) -> str:
```

四个核心参数各有用途：

| 参数 | 类型 | 说明 |
|------|------|------|
| `description` | `str` | 3-5 个词的简短描述，用于日志和前端展示 |
| `prompt` | `str` | 子任务的详细描述，Sub-Agent 的输入 |
| `subagent_type` | `Literal["general-purpose", "bash"]` | 选择子 Agent 类型 |
| `max_turns` | `int \| None` | 可选，覆盖默认最大轮次 |

`tool_call_id` 由框架自动注入，用作 `task_id`，这样可以在 Lead Agent 和 Sub-Agent 之间建立精确的追踪关联。

## 8.3 两种 Sub-Agent 类型

DeerFlow 内置了两种 Sub-Agent 配置，定义在 `subagents/builtins/` 目录下。

### general-purpose：通用型

```python
GENERAL_PURPOSE_CONFIG = SubagentConfig(
    name="general-purpose",
    tools=None,  # 继承父 Agent 的所有工具
    disallowed_tools=["task", "ask_clarification", "present_files"],
    model="inherit",
    max_turns=50,
)
```

通用型 Sub-Agent 拥有除 `task`、`ask_clarification`、`present_files` 之外的所有工具。它适用于需要多步推理、文件操作、网络搜索等复杂场景。50 轮的上限足以应对大多数复杂任务。

### bash：命令执行型

```python
BASH_AGENT_CONFIG = SubagentConfig(
    name="bash",
    tools=["bash", "ls", "read_file", "write_file", "str_replace"],
    disallowed_tools=["task", "ask_clarification", "present_files"],
    model="inherit",
    max_turns=30,
)
```

bash 型 Sub-Agent 只配备了沙箱文件操作相关的 5 个工具，专门用于 git 操作、构建流程、测试执行等场景。30 轮的上限比通用型更低，因为命令执行任务通常不需要太多交互轮次。

两者共同点是：模型继承自父 Agent（`model="inherit"`），且都禁止嵌套调用 `task`。

## 8.4 并发限制与超时

Sub-Agent 系统设计了多层保护机制：

**并发限制**：最多 3 个 Sub-Agent 并行执行。这个限制在线程池和 Middleware 两个层面同时生效：

```python
# executor.py 中的线程池定义
_scheduler_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="subagent-scheduler-")
_execution_pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="subagent-exec-")

MAX_CONCURRENT_SUBAGENTS = 3
```

**超时机制**：默认 15 分钟（900 秒），在 `SubagentConfig` 中配置：

```python
@dataclass
class SubagentConfig:
    # ...
    timeout_seconds: int = 900  # 默认 15 分钟
```

超时由 `config.yaml` 的运行时覆盖机制支持，不同环境可以设置不同的超时时间。

## 8.5 Sub-Agent 是精简版 Lead Agent

Sub-Agent 与 Lead Agent 使用相同的底层 Agent 框架，但 Middleware 栈大幅精简。Lead Agent 可能有 5-6 个 Middleware，而 Sub-Agent 只有 2 个：

```python
def _create_agent(self):
    model = create_chat_model(name=model_name, thinking_enabled=False)

    middlewares = [
        ThreadDataMiddleware(lazy_init=True),   # 计算线程路径
        SandboxMiddleware(lazy_init=True),       # 复用父 Agent 的沙箱
    ]

    return create_agent(
        model=model,
        tools=self.tools,
        middleware=middlewares,
        system_prompt=self.config.system_prompt,
        state_schema=ThreadState,
    )
```

注意 `lazy_init=True` 这个关键参数。它告诉 Middleware 不要重新初始化资源，而是复用父 Agent 已经创建好的沙箱和线程数据。这意味着：

- **共享沙箱**：Sub-Agent 与 Lead Agent 操作同一个沙箱环境，文件系统状态互通
- **共享线程数据**：路径计算、上传文件列表等数据直接复用

## 8.6 上下文隔离与 trace_id 追踪

虽然沙箱和线程数据是共享的，但 Sub-Agent 的**对话上下文是完全隔离的**。每个 Sub-Agent 从一条 `HumanMessage` 开始，拥有独立的消息历史：

```python
def _build_initial_state(self, task: str) -> dict[str, Any]:
    state: dict[str, Any] = {
        "messages": [HumanMessage(content=task)],
    }
    if self.sandbox_state is not None:
        state["sandbox"] = self.sandbox_state
    if self.thread_data is not None:
        state["thread_data"] = self.thread_data
    return state
```

这种设计避免了子任务之间的上下文污染，每个 Sub-Agent 只看到自己需要处理的 prompt，不会被其他子任务的中间结果干扰。

为了在隔离的上下文之间建立关联，DeerFlow 使用 `trace_id` 实现分布式追踪：

```python
# 从父 Agent 传递或自动生成
trace_id = metadata.get("trace_id") or str(uuid.uuid4())[:8]
```

所有日志都带有 `[trace=xxx]` 前缀，使得同一用户请求产生的所有 Sub-Agent 活动可以被串联起来。在调试和监控场景中，通过一个 trace_id 就能追踪整个任务分解与执行的完整链路。

## 8.7 注册表与配置覆盖

`registry.py` 提供了 Sub-Agent 的注册和查找机制：

```python
def get_subagent_config(name: str) -> SubagentConfig | None:
    config = BUILTIN_SUBAGENTS.get(name)
    if config is None:
        return None

    # 支持 config.yaml 的运行时覆盖
    app_config = get_subagents_app_config()
    effective_timeout = app_config.get_timeout_for(name)
    if effective_timeout != config.timeout_seconds:
        config = replace(config, timeout_seconds=effective_timeout)

    return config
```

注册表使用 `dataclasses.replace` 进行不可变更新，原始配置对象不会被修改。这让配置覆盖既安全又可追溯。

### 8.8 上下文隔离是刻意设计，不是缺陷

读到 8.6 节时，很多人会产生疑问：为什么 Sub-Agent 看不到 Lead Agent 的对话历史？这不是信息丢失吗？

答案是：**这是刻意为之的架构决策，而非实现上的偷懒。**

Sub-Agent 启动时只收到一条 `HumanMessage`，内容就是 Lead Agent 通过 `task` 工具传入的 `prompt` 参数。它无法看到三类信息：父 Agent 的完整对话历史、其他 Sub-Agent 已经产出的中间结果、以及用户最初的聊天上下文。

这种隔离带来的好处远大于代价。一个专注于单一任务的 Agent，其推理质量显著优于一个被大量无关上下文淹没的 Agent。当你让一个 Sub-Agent 去"搜索 Python 异步编程的最佳实践"时，它不需要知道用户之前问过天气预报、Lead Agent 曾经执行过文件读取、另一个 Sub-Agent 正在编译代码。这些信息不仅无用，还会占用宝贵的上下文窗口，稀释真正重要的指令。

这意味着 Lead Agent 的 `prompt` 参数必须是**自包含的**。它不能写"继续之前的搜索"，因为 Sub-Agent 不知道"之前"是什么。Lead Agent 需要将所有必要的背景信息、约束条件、输出格式要求全部打包进这一条消息中。这就像给外包团队写需求文档——你不能把整个项目历史甩给对方，而是要写一份清晰完整的任务说明书。

从工程角度看，上下文隔离还带来了一个额外好处：**可重放性**。由于 Sub-Agent 的输入完全由单条 prompt 决定，相同的 prompt 在相同的沙箱状态下应该产生相同的结果，这极大简化了调试和测试。

### 8.9 lazy_init=True：沙箱共享的初始化优化

8.5 节提到 Sub-Agent 的两个 Middleware 都使用了 `lazy_init=True`，这个参数的具体含义值得展开。

对于 `ThreadDataMiddleware`，`lazy_init=True` 意味着它在 `before_agent` 阶段只做路径计算——根据 `thread_id` 推导出线程数据目录的路径并写入 state，但**不会创建目录**。因为父 Agent 在启动时已经创建了这些目录，Sub-Agent 无需重复操作。

对于 `SandboxMiddleware`，行为更为巧妙。正常模式下，`before_agent` 会调用沙箱管理器的 `acquire()` 方法来创建或获取一个沙箱实例。但在 `lazy_init=True` 模式下，这个 `acquire()` 调用被完全跳过。那 Sub-Agent 怎么获取沙箱？答案在 `_build_initial_state` 中——父 Agent 的 `sandbox_state` 被直接注入到 Sub-Agent 的初始 state 中。当 Sub-Agent 的工具需要执行沙箱操作时，会调用 `ensure_sandbox_initialized()`，此时它在 state 中找到已有的 `sandbox_state`，直接通过 ID 查找到父 Agent 正在使用的沙箱实例。

这个设计的净效果是：**Sub-Agent 的 Middleware 初始化阶段零 I/O 开销**。没有目录创建、没有沙箱分配、没有网络请求。Sub-Agent 从第一轮对话开始就可以直接使用父 Agent 的完整沙箱环境，文件系统状态完全互通。

### 8.10 trace_id 的完整生成和传递链路

trace_id 的生命周期贯穿整个请求处理链路，理解它的传递过程有助于掌握 DeerFlow 的可观测性设计。

完整链路如下：

1. **用户请求到达 FastAPI**：HTTP 请求被路由到对应的 endpoint，框架分配或复用一个 `thread_id` 来标识会话
2. **Lead Agent 开始处理**：运行时的 `metadata` 字典中可能已经携带了上游传入的 `trace_id`
3. **Lead Agent 调用 task 工具**：`task_tool` 内部创建 `SubagentExecutor`，从 `metadata` 中提取 `trace_id`；如果不存在，则通过 `str(uuid.uuid4())[:8]` 生成一个 8 字符的短 UUID
4. **SubagentExecutor 执行**：整个执行过程中，所有日志输出都带有 `[trace=xxx]` 前缀，包括启动信息、工具调用记录、错误信息和完成通知
5. **结果回传**：`SubagentResult` 数据结构中包含 `trace_id` 字段，Lead Agent 可以据此将结果与原始任务关联
6. **同源追踪**：同一个 Lead Agent 在同一轮对话中创建的所有 Sub-Agent 共享相同的 `trace_id`，使得属于同一批次的并行任务在日志中可以被一次性检索

在生产环境中，运维人员只需一个 `trace_id` 就能从日志系统中还原出完整的任务分解树：哪些子任务被创建、各自执行了多长时间、哪个先完成、哪个超时——这些信息对性能优化和故障排查都至关重要。

### 8.11 Sub-Agent 的 system prompt 构建

Lead Agent 和 Sub-Agent 虽然共享相同的底层 Agent 框架，但它们的 system prompt 在复杂度上有天壤之别。

**Lead Agent 的 system prompt** 是一个复杂的模板拼接结果。它包含记忆注入（从向量数据库检索的历史交互摘要）、Skill 描述（每个已注册 Skill 的名称和触发条件）、工具文档（每个可用工具的参数说明）、以及用户上下文（偏好设置、角色信息等）。这个 prompt 可以轻易超过数千 token。

**general-purpose Sub-Agent 的 system prompt** 则截然不同。它聚焦于执行效率：指导 Agent 高效使用工具、采用分步推理策略、避免不必要的确认。prompt 中还包含一个标准化的输出格式模板，要求 Sub-Agent 按照"摘要—发现—产出物—问题—引用"的结构组织最终回复。没有记忆注入，没有 Skill 描述，也没有澄清能力——Sub-Agent 不能向用户提问，必须基于收到的 prompt 独立完成任务。

**bash 型 Sub-Agent 的 system prompt** 更加精简，专注于命令执行的最佳实践：错误处理模式（检查退出码、捕获 stderr）、顺序执行与并行执行的选择策略、以及沙箱环境的使用约束。

这种分层设计确保每种 Agent 只携带与自身职责相关的指令，最大化利用有限的上下文窗口。

### 8.12 general-purpose 工具集的过滤逻辑

general-purpose Sub-Agent 的工具配置看似简单——`tools=None` 表示继承父 Agent 的全部工具——但实际的过滤逻辑值得深入理解。

`tools=None` 首先意味着 Sub-Agent 拿到的是父 Agent 工具列表的完整副本。然后，`disallowed_tools` 列表中的三个工具会被逐一移除：

- **移除 `task`**：这是防止递归嵌套的关键。如果 Sub-Agent 也能创建 Sub-Agent，系统将面临不可控的递归深度和资源消耗。单层委派模型是 DeerFlow 的核心架构约束。
- **移除 `ask_clarification`**：Sub-Agent 无法与用户对话。它不像 Lead Agent 那样有澄清机制来处理模糊需求。如果任务描述不够清晰，Sub-Agent 只能尽力推断意图或在结果中标注不确定性。这也从反面强调了 Lead Agent 在构造 prompt 时必须做到自包含。
- **移除 `present_files`**：文件呈现是 Lead Agent 的专属职责。Sub-Agent 可以在沙箱中创建和修改文件，但向用户展示文件内容的交互行为必须由 Lead Agent 统一管理，以确保用户界面的一致性。

bash 型 Sub-Agent 采用了相反的策略：不是从全集中移除，而是使用**显式白名单**。只有 `bash`、`ls`、`read_file`、`write_file`、`str_replace` 这 5 个工具被允许。这种最小权限原则确保 bash 型 Agent 不会意外调用网络搜索、代码分析等与命令执行无关的工具，也降低了安全风险。

两种策略的对比体现了 DeerFlow 在工具管理上的灵活性：通用型用黑名单提供最大能力，专用型用白名单保证最小攻击面。

## 小结

DeerFlow 的 Sub-Agent 架构遵循"简洁而不简单"的设计哲学：

- Lead Agent 作为编排者，通过 `task` 工具创建 Sub-Agent
- 两种内置类型覆盖了通用任务和命令执行两大场景
- 最多 3 个并行、15 分钟超时的双重保护确保系统稳定
- Sub-Agent 只带 2 个 Middleware，通过 `lazy_init=True` 复用父 Agent 资源
- 沙箱共享、上下文隔离的设计兼顾了协作与独立
- trace_id 贯穿整条链路，为可观测性提供了基础

下一章我们将深入 `SubagentExecutor`，看看 Sub-Agent 的执行引擎是如何实现双线程池调度、状态管理和超时处理的。
