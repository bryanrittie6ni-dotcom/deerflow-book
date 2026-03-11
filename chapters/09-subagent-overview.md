# 第 9 章　Sub-Agent 架构总览

当一个 AI Agent 面对的任务足够复杂时，单线程逐步执行的效率就会成为瓶颈。DeerFlow 的 Sub-Agent 系统正是为此而设计：Lead Agent 扮演"指挥官"角色，将复杂任务拆解为多个独立子任务，交由专门的 Sub-Agent 并行执行，最后综合结果交付给用户。

本章将从整体架构出发，完整梳理 Sub-Agent 的设计理念、API 接口、类型体系以及与 Lead Agent 之间的协作关系。

## 9.1 Lead Agent 与 Sub-Agent 的关系

在 DeerFlow 中，Lead Agent 是用户直接交互的主 Agent。它拥有完整的 Middleware 栈、澄清机制、Skill 系统等能力。当遇到可并行分解的复杂任务时，Lead Agent 通过调用 `task` 工具创建 Sub-Agent。

两者的关系可以概括为：

- **Lead Agent 是编排者**：负责任务分解、批次规划、结果综合
- **Sub-Agent 是执行者**：在隔离上下文中自主完成单个子任务
- **不可嵌套**：Sub-Agent 无法再创建 Sub-Agent，`task` 工具在子 Agent 的工具列表中被显式排除

这种单层委派模型避免了递归嵌套带来的复杂度和资源消耗问题。

## 9.2 task 工具的完整 API

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

## 9.3 两种 Sub-Agent 类型

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

## 9.4 并发限制与超时

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

## 9.5 Sub-Agent 是精简版 Lead Agent

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

## 9.6 上下文隔离与 trace_id 追踪

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

## 9.7 注册表与配置覆盖

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

## 小结

DeerFlow 的 Sub-Agent 架构遵循"简洁而不简单"的设计哲学：

- Lead Agent 作为编排者，通过 `task` 工具创建 Sub-Agent
- 两种内置类型覆盖了通用任务和命令执行两大场景
- 最多 3 个并行、15 分钟超时的双重保护确保系统稳定
- Sub-Agent 只带 2 个 Middleware，通过 `lazy_init=True` 复用父 Agent 资源
- 沙箱共享、上下文隔离的设计兼顾了协作与独立
- trace_id 贯穿整条链路，为可观测性提供了基础

下一章我们将深入 `SubagentExecutor`，看看 Sub-Agent 的执行引擎是如何实现双线程池调度、状态管理和超时处理的。
