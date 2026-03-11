# 第 8 章　Context Engineering：上下文工程

Agent 系统面临的最大工程挑战不是模型能力，而是上下文窗口管理。一个执行复杂任务的 Agent 可能经历数十轮工具调用，每轮都会向消息历史中追加内容。当上下文接近模型的 token 上限时，系统必须做出取舍——保留什么、丢弃什么、如何在压缩后不丢失关键信息。DeerFlow 通过多层中间件协作，构建了一套完整的上下文工程方案。

## 8.1 上下文的本质：内存与磁盘

理解 DeerFlow 的上下文管理，需要一个关键类比：

> **消息历史是内存，文件系统是磁盘。**

Agent 的消息历史（`state["messages"]`）就像 CPU 的工作内存——容量有限但访问极快。文件系统（沙箱的 `/mnt/user-data/workspace`）则是持久存储——容量几乎无限但需要显式读写。

DeerFlow 的设计哲学是：不要把所有信息塞进上下文，而是将长期数据写入文件，只在需要时通过工具调用读取。系统提示词中明确定义了这个模式：

```
- User workspace: /mnt/user-data/workspace - Working directory for temporary files
- Output files: /mnt/user-data/outputs - Final deliverables must be saved here
```

当 Agent 执行代码分析任务时，它不会把整个代码文件放入消息历史，而是通过 `read_file` 工具按需读取。产出物通过 `present_file` 写入 outputs 目录。这种"内存-磁盘"分层策略是控制上下文膨胀的第一道防线。

## 8.2 SummarizationMiddleware 深度解析

当第一道防线不够时，DeerFlow 启用自动摘要机制。`SummarizationMiddleware` 是 LangChain 内置的中间件，但 DeerFlow 通过 `SummarizationConfig` 提供了精细的配置能力。

### 配置模型

```python
class SummarizationConfig(BaseModel):
    enabled: bool = Field(default=False)
    model_name: str | None = Field(default=None)
    trigger: ContextSize | list[ContextSize] | None = Field(default=None)
    keep: ContextSize = Field(
        default_factory=lambda: ContextSize(type="messages", value=20)
    )
    trim_tokens_to_summarize: int | None = Field(default=4000)
    summary_prompt: str | None = Field(default=None)
```

### 三种触发方式

`trigger` 参数定义了何时启动摘要，支持三种 `ContextSizeType`：

```python
ContextSizeType = Literal["fraction", "tokens", "messages"]

class ContextSize(BaseModel):
    type: ContextSizeType
    value: int | float

    def to_tuple(self):
        return (self.type, self.value)
```

| 类型 | 含义 | 示例 |
|------|------|------|
| `messages` | 消息数量超过阈值 | `{"type": "messages", "value": 50}` — 超过 50 条消息时触发 |
| `tokens` | Token 数量超过阈值 | `{"type": "tokens", "value": 4000}` — 超过 4000 tokens 时触发 |
| `fraction` | 模型最大输入的百分比 | `{"type": "fraction", "value": 0.8}` — 达到模型容量 80% 时触发 |

`trigger` 可以是单个阈值，也可以是多个阈值的列表——任意一个满足即触发。这是处理方式：

```python
if isinstance(config.trigger, list):
    trigger = [t.to_tuple() for t in config.trigger]
else:
    trigger = config.trigger.to_tuple()
```

### keep_recent：保留策略

摘要触发后，`keep` 参数决定保留多少最近的上下文：

```python
keep: ContextSize = Field(
    default_factory=lambda: ContextSize(type="messages", value=20)
)
```

默认保留最近 20 条消息。被截断的旧消息会被 LLM 压缩为一段摘要文本，作为"记忆"注入到上下文开头。

### trim_tokens_to_summarize

这是一个容易被忽视但非常重要的参数：

```python
trim_tokens_to_summarize: int | None = Field(default=4000)
```

它限制了送入摘要模型的 token 数量。如果历史消息有 10 万 tokens，不可能把它们全部发送给摘要模型——那会产生巨大的延迟和费用。`trim_tokens_to_summarize=4000` 表示只取最前面的 4000 tokens 进行摘要。设为 `None` 则跳过裁剪。

### 模型选择

```python
if config.model_name:
    model = config.model_name
else:
    model = create_chat_model(thinking_enabled=False)
```

摘要默认使用一个轻量模型（关闭 Thinking），因为摘要任务不需要深度推理，使用小模型可以显著节省成本。

## 8.3 DanglingToolCallMiddleware：修复上下文中的断裂

悬空工具调用（Dangling Tool Call）是 Agent 系统中一个容易被忽视的问题。它发生在以下场景：

1. 用户在 Agent 执行工具时中断了对话
2. 请求因超时或错误被取消
3. 前端断开连接

此时消息历史中会残留如下结构：

```
AIMessage(tool_calls=[{id: "abc", name: "bash", args: {...}}])
# 缺少对应的 ToolMessage(tool_call_id="abc")
```

大多数 LLM API 要求 `tool_calls` 和 `ToolMessage` 严格配对，否则会报格式错误。`DanglingToolCallMiddleware` 的修复逻辑：

```python
def _build_patched_messages(self, messages):
    # 收集所有已有的 ToolMessage ID
    existing_tool_msg_ids = set()
    for msg in messages:
        if isinstance(msg, ToolMessage):
            existing_tool_msg_ids.add(msg.tool_call_id)

    # 在正确位置插入占位 ToolMessage
    patched = []
    for msg in messages:
        patched.append(msg)
        if getattr(msg, "type", None) != "ai":
            continue
        for tc in getattr(msg, "tool_calls", None) or []:
            tc_id = tc.get("id")
            if tc_id and tc_id not in existing_tool_msg_ids:
                patched.append(ToolMessage(
                    content="[Tool call was interrupted and did not return a result.]",
                    tool_call_id=tc_id,
                    name=tc.get("name", "unknown"),
                    status="error",
                ))
    return patched
```

这里有一个精妙的设计选择：它使用 `wrap_model_call` 钩子而非 `before_model`。原因在于 `before_model` 返回的消息只能追加到列表末尾（通过 `add_messages` reducer），但占位 ToolMessage 需要紧跟在对应的 AIMessage 之后。`wrap_model_call` 允许直接替换整个消息列表，实现精确的位置插入。

## 8.4 TodoMiddleware：上下文丢失后的自愈

`TodoMiddleware` 解决的是一个更深层的问题：当 `SummarizationMiddleware` 截断旧消息时，可能把 `write_todos` 工具调用也一并截断了，导致模型"遗忘"了当前的任务列表。

它的检测逻辑非常简洁：

```python
def before_model(self, state, runtime):
    todos = state.get("todos") or []
    if not todos:
        return None  # 没有 todos，无需干预

    messages = state.get("messages") or []
    if _todos_in_messages(messages):
        return None  # write_todos 仍在上下文中

    if _reminder_in_messages(messages):
        return None  # 已经注入过提醒

    # 上下文丢失！注入提醒
    formatted = _format_todos(todos)
    reminder = HumanMessage(
        name="todo_reminder",
        content=(
            "<system_reminder>\n"
            "Your todo list from earlier is no longer visible...\n\n"
            f"{formatted}\n\n"
            "Continue tracking and updating this todo list as you work.\n"
            "</system_reminder>"
        ),
    )
    return {"messages": [reminder]}
```

这是一个自愈模式的经典实现：

1. **状态 vs 上下文**：`todos` 保存在 `ThreadState` 中（持久化），但模型只能看到消息历史中的内容。
2. **检测断裂**：通过扫描消息历史中是否存在 `write_todos` 工具调用来判断。
3. **注入修复**：将当前 todos 状态格式化为提醒消息注入。
4. **去重保护**：通过 `_reminder_in_messages` 避免重复注入。

`_todos_in_messages` 的检测方式直接明了：

```python
def _todos_in_messages(messages):
    for msg in messages:
        if isinstance(msg, AIMessage) and msg.tool_calls:
            for tc in msg.tool_calls:
                if tc.get("name") == "write_todos":
                    return True
    return False
```

## 8.5 Sub-agent 上下文隔离

DeerFlow 的 Sub-agent 架构天然提供了上下文隔离。当 Lead Agent 将复杂任务分解为多个子任务时，每个 Sub-agent 拥有独立的消息历史：

- Lead Agent 只向 Sub-agent 传递任务描述（`prompt` 参数）
- Sub-agent 执行过程中的所有工具调用和中间结果不会回流到 Lead Agent 的上下文
- Sub-agent 完成后只返回最终结果

这相当于一种结构化的上下文压缩：一个可能占据数千 tokens 的研究过程，最终只以几百 tokens 的结果摘要形式出现在 Lead Agent 的上下文中。

`SubagentLimitMiddleware` 进一步通过硬性限制并发数来控制上下文的膨胀速度：

```python
def __init__(self, max_concurrent=MAX_CONCURRENT_SUBAGENTS):
    self.max_concurrent = _clamp_subagent_limit(max_concurrent)  # [2, 4]
```

即使所有 Sub-agent 同时返回结果，最多也只有 4 个结果需要被整合到 Lead Agent 的上下文中。

## 8.6 上下文工程的全景图

将所有机制串联起来，DeerFlow 的上下文管理形成了一个多层防御体系：

| 层级 | 机制 | 策略 |
|------|------|------|
| L0 | 文件系统 | 将长期数据写入文件，不进入上下文 |
| L1 | Sub-agent 隔离 | 子任务的中间过程不污染主上下文 |
| L2 | SummarizationMiddleware | 自动压缩过长的历史消息 |
| L3 | TodoMiddleware | 摘要后自动恢复关键状态信息 |
| L4 | DanglingToolCallMiddleware | 修复截断导致的消息格式错误 |
| L5 | MemoryMiddleware | 跨会话记忆，降低单次会话的上下文压力 |

每一层都在前一层的基础上补充，形成纵深防御。文件系统是被动防御（减少进入上下文的数据量），Summarization 是主动防御（压缩已有数据），TodoMiddleware 是恢复机制（修复压缩造成的信息丢失），DanglingToolCallMiddleware 是容错机制（修复异常中断造成的格式问题）。

## 8.7 实践指导：配置摘要策略

对于不同的使用场景，摘要配置应有不同的策略：

**短对话场景**（如问答助手）：可以关闭摘要，依赖模型的原生上下文窗口。

```yaml
summarization:
  enabled: false
```

**长任务场景**（如代码分析、研究报告）：启用摘要，使用消息数量触发。

```yaml
summarization:
  enabled: true
  trigger:
    type: messages
    value: 30
  keep:
    type: messages
    value: 10
  trim_tokens_to_summarize: 4000
```

**高并发场景**（如多用户服务）：使用 fraction 模式，按模型容量的百分比触发，避免硬编码阈值。

```yaml
summarization:
  enabled: true
  trigger:
    type: fraction
    value: 0.75
  keep:
    type: fraction
    value: 0.25
```

## 小结

上下文工程是 Agent 系统中最容易被忽视但影响最深远的工程问题。DeerFlow 的解决方案有以下关键洞察：

1. **分层存储**：将"内存"（消息历史）和"磁盘"（文件系统）的概念引入 Agent 架构，让 Agent 像操作系统一样管理数据。
2. **自动摘要**：三种触发方式（messages/tokens/fraction）覆盖不同场景，`trim_tokens_to_summarize` 控制摘要成本。
3. **状态与上下文分离**：`ThreadState` 中的 `todos` 是持久状态，消息历史是易失上下文。`TodoMiddleware` 负责在两者之间同步。
4. **容错优先**：`DanglingToolCallMiddleware` 不试图恢复中断的操作，而是插入一条错误消息让模型知道发生了什么，由模型决定下一步。
5. **隔离即压缩**：Sub-agent 的独立上下文天然实现了信息压缩，一个复杂的子任务只以结果形式出现在主上下文中。

在实际部署中，上下文工程的配置需要根据模型的上下文窗口大小、典型任务复杂度和成本预算来调优。没有万能的配置，但理解每一层机制的原理，就能为特定场景找到最佳平衡点。
