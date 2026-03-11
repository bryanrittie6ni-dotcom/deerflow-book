# 第 6 章　11 层中间件管道：Agent 的神经系统

如果 Lead Agent 是大脑，那么中间件管道就是它的神经系统。DeerFlow 通过最多 11 层中间件处理所有 Cross-cutting Concerns——从沙箱环境初始化到对话摘要，从悬空工具调用修复到澄清请求拦截。本章逐一拆解每一层中间件的源码与设计意图。

## 6.1 为什么需要中间件

Agent 的核心逻辑是"接收消息 -> 调用模型 -> 执行工具 -> 返回结果"。但在这个主循环之外，有大量的横切关注点（Cross-cutting Concerns）需要处理：

- 每次对话需要创建沙箱目录
- 用户上传的文件需要注入到消息上下文
- 对话过长时需要自动摘要
- 模型可能生成悬空的工具调用
- 首次对话后需要自动生成标题

如果把这些逻辑全部写在主循环中，代码会迅速膨胀且难以维护。中间件模式将这些关注点解耦为独立的、可组合的层，每一层只关心自己的职责。

## 6.2 中间件链的构建

`_build_middlewares` 函数负责根据运行时配置动态组装中间件链：

```python
def _build_middlewares(config: RunnableConfig, model_name: str | None,
                       agent_name: str | None = None):
    middlewares = [
        ThreadDataMiddleware(),
        UploadsMiddleware(),
        SandboxMiddleware(),
        DanglingToolCallMiddleware(),
    ]

    # 可选：Summarization
    summarization_middleware = _create_summarization_middleware()
    if summarization_middleware is not None:
        middlewares.append(summarization_middleware)

    # 可选：TodoList（仅 Plan Mode）
    is_plan_mode = config.get("configurable", {}).get("is_plan_mode", False)
    todo_list_middleware = _create_todo_list_middleware(is_plan_mode)
    if todo_list_middleware is not None:
        middlewares.append(todo_list_middleware)

    middlewares.append(TitleMiddleware())
    middlewares.append(MemoryMiddleware(agent_name=agent_name))

    # 可选：ViewImage（仅视觉模型）
    model_config = app_config.get_model_config(model_name)
    if model_config is not None and model_config.supports_vision:
        middlewares.append(ViewImageMiddleware())

    # 可选：SubagentLimit（仅 Subagent 模式）
    if subagent_enabled:
        middlewares.append(SubagentLimitMiddleware(max_concurrent=max_concurrent_subagents))

    # ClarificationMiddleware 必须最后
    middlewares.append(ClarificationMiddleware())
    return middlewares
```

源码中对顺序有详细注释，每一层的位置都有明确的依赖原因。

## 6.3 完整的 11 层中间件

### 第 1 层：ThreadDataMiddleware

**职责**：为每个对话线程创建工作目录结构。

**钩子**：`before_agent`

```python
class ThreadDataMiddleware(AgentMiddleware[ThreadDataMiddlewareState]):
    def __init__(self, base_dir=None, lazy_init=True):
        self._paths = Paths(base_dir) if base_dir else get_paths()
        self._lazy_init = lazy_init

    def before_agent(self, state, runtime):
        thread_id = runtime.context.get("thread_id")
        if self._lazy_init:
            paths = self._get_thread_paths(thread_id)  # 仅计算路径
        else:
            paths = self._create_thread_directories(thread_id)  # 立即创建
        return {"thread_data": {**paths}}
```

默认使用惰性初始化（`lazy_init=True`），只计算路径而不创建目录，等到沙箱工具真正需要时再创建，避免不必要的 I/O 开销。

### 第 2 层：UploadsMiddleware

**职责**：将用户上传的文件信息注入到消息上下文。

**钩子**：`before_agent`

```python
class UploadsMiddleware(AgentMiddleware[UploadsMiddlewareState]):
    def before_agent(self, state, runtime):
        # 从最后一条 HumanMessage 的 additional_kwargs.files 提取新上传文件
        new_files = self._files_from_kwargs(last_message, uploads_dir) or []
        # 从 uploads 目录扫描历史文件
        historical_files = [...]
        # 生成 <uploaded_files> 标签并注入到消息内容前部
        files_message = self._create_files_message(new_files, historical_files)
        updated_message = HumanMessage(
            content=f"{files_message}\n\n{original_content}",
            id=last_message.id,
            additional_kwargs=last_message.additional_kwargs,
        )
        return {"uploaded_files": new_files, "messages": messages}
```

它将文件信息格式化为 `<uploaded_files>` XML 块，前置到用户消息中，让模型知道有哪些文件可用以及它们的路径。

### 第 3 层：SandboxMiddleware

**职责**：为对话线程分配沙箱环境。

**钩子**：`before_agent` / `after_agent`

```python
class SandboxMiddleware(AgentMiddleware[SandboxMiddlewareState]):
    def before_agent(self, state, runtime):
        if self._lazy_init:
            return super().before_agent(state, runtime)
        # 急切模式：立即获取沙箱
        sandbox_id = self._acquire_sandbox(thread_id)
        return {"sandbox": {"sandbox_id": sandbox_id}}

    def after_agent(self, state, runtime):
        sandbox = state.get("sandbox")
        if sandbox is not None:
            get_sandbox_provider().release(sandbox["sandbox_id"])
```

`SandboxMiddleware` 必须位于 `ThreadDataMiddleware` 之后，因为它可能需要 `thread_id` 来获取沙箱。`after_agent` 负责释放沙箱资源，但沙箱不会在每轮对话后销毁，而是跨轮次复用，只在应用关闭时统一清理。

### 第 4 层：DanglingToolCallMiddleware

**职责**：修复消息历史中的悬空工具调用。

**钩子**：`wrap_model_call`

```python
class DanglingToolCallMiddleware(AgentMiddleware[AgentState]):
    def wrap_model_call(self, request, handler):
        patched = self._build_patched_messages(request.messages)
        if patched is not None:
            request = request.override(messages=patched)
        return handler(request)
```

当用户中断对话或请求被取消时，消息历史中可能残留 AIMessage 的 `tool_calls` 但缺少对应的 `ToolMessage`。这种不完整的消息格式会导致 LLM 报错。此中间件在模型调用前扫描并注入占位 `ToolMessage`：

```python
patched.append(ToolMessage(
    content="[Tool call was interrupted and did not return a result.]",
    tool_call_id=tc_id,
    name=tc.get("name", "unknown"),
    status="error",
))
```

注意它使用 `wrap_model_call` 而非 `before_model`，因为需要在消息列表的正确位置（紧跟悬空 AIMessage 之后）插入补丁，而 `before_model` 只能在列表末尾追加。

### 第 5 层：SummarizationMiddleware（可选）

**职责**：当对话超过阈值时自动生成摘要，压缩上下文。

这是 LangChain 内置的中间件，由 DeerFlow 的 `_create_summarization_middleware` 配置：

```python
def _create_summarization_middleware():
    config = get_summarization_config()
    if not config.enabled:
        return None
    return SummarizationMiddleware(
        model=config.model_name or create_chat_model(thinking_enabled=False),
        trigger=[t.to_tuple() for t in config.trigger],
        keep=config.keep.to_tuple(),
        trim_tokens_to_summarize=config.trim_tokens_to_summarize,
    )
```

详细的摘要策略将在第 8 章展开。

### 第 6 层：TodoMiddleware（可选，仅 Plan Mode）

**职责**：在 Plan Mode 下维护任务列表，并在摘要后恢复上下文。

**钩子**：`before_model`

```python
class TodoMiddleware(TodoListMiddleware):
    def before_model(self, state, runtime):
        todos = state.get("todos") or []
        if not todos:
            return None
        messages = state.get("messages") or []
        if _todos_in_messages(messages):
            return None  # write_todos 仍在上下文中，无需干预
        if _reminder_in_messages(messages):
            return None  # 已有提醒
        # 上下文被截断，注入提醒
        reminder = HumanMessage(
            name="todo_reminder",
            content="<system_reminder>\nYour todo list from earlier...\n</system_reminder>",
        )
        return {"messages": [reminder]}
```

这是一个精妙的设计：当 `SummarizationMiddleware` 截断了包含 `write_todos` 工具调用的消息时，模型会丢失对任务列表的感知。`TodoMiddleware` 通过检测上下文中是否还有 `write_todos` 调用来判断是否需要注入提醒消息。

### 第 7 层：TitleMiddleware

**职责**：在首次完整对话后自动生成线程标题。

**钩子**：`aafter_model`（异步）

```python
class TitleMiddleware(AgentMiddleware[TitleMiddlewareState]):
    async def aafter_model(self, state, runtime):
        if self._should_generate_title(state):
            title = await self._generate_title(state)
            return {"title": title}
        return None
```

它使用一个轻量模型（`thinking_enabled=False`）来生成标题，只在第一次完整的用户-助手交互后触发。如果 LLM 调用失败，会降级使用用户消息的前 50 个字符作为标题。

### 第 8 层：MemoryMiddleware

**职责**：在 Agent 执行完毕后将对话提交到记忆队列。

**钩子**：`after_agent`

```python
class MemoryMiddleware(AgentMiddleware[MemoryMiddlewareState]):
    def after_agent(self, state, runtime):
        config = get_memory_config()
        if not config.enabled:
            return None
        filtered_messages = _filter_messages_for_memory(messages)
        queue = get_memory_queue()
        queue.add(thread_id=thread_id, messages=filtered_messages,
                  agent_name=self._agent_name)
        return None
```

关键细节：它会过滤掉工具调用消息和中间步骤，只保留用户输入与最终助手回复。还会清除 `UploadsMiddleware` 注入的 `<uploaded_files>` 块，因为文件路径是会话级别的临时数据，不应持久化到长期记忆中。

### 第 9 层：ViewImageMiddleware（可选，仅视觉模型）

**职责**：在 `view_image` 工具执行完毕后，将图片 base64 数据注入到消息流中。

**钩子**：`before_model`

```python
class ViewImageMiddleware(AgentMiddleware[ViewImageMiddlewareState]):
    def before_model(self, state, runtime):
        if not self._should_inject_image_message(state):
            return None
        image_content = self._create_image_details_message(state)
        return {"messages": [HumanMessage(content=image_content)]}
```

它检查最后一个 AI 消息是否包含 `view_image` 工具调用，且所有工具调用都已完成（有对应的 ToolMessage），然后将图片数据以 `image_url` 格式注入，让多模态模型能"看到"图片。

### 第 10 层：SubagentLimitMiddleware（可选，仅 Subagent 模式）

**职责**：截断模型响应中多余的 `task` 工具调用。

**钩子**：`after_model`

```python
class SubagentLimitMiddleware(AgentMiddleware[AgentState]):
    def __init__(self, max_concurrent=MAX_CONCURRENT_SUBAGENTS):
        self.max_concurrent = _clamp_subagent_limit(max_concurrent)  # [2, 4]

    def after_model(self, state, runtime):
        # 统计 task 调用数量，超出限制则截断
        task_indices = [i for i, tc in enumerate(tool_calls) if tc.get("name") == "task"]
        if len(task_indices) <= self.max_concurrent:
            return None
        indices_to_drop = set(task_indices[self.max_concurrent:])
        truncated_tool_calls = [tc for i, tc in enumerate(tool_calls)
                                if i not in indices_to_drop]
        updated_msg = last_msg.model_copy(update={"tool_calls": truncated_tool_calls})
        return {"messages": [updated_msg]}
```

即使 Prompt 中已经明确告知并发限制，LLM 仍可能生成超出限额的 `task` 调用。这层中间件是最后的硬性防线，通过 `_clamp_subagent_limit` 将并发数强制限制在 [2, 4] 的范围内。

### 第 11 层：ClarificationMiddleware（必须最后）

**职责**：拦截 `ask_clarification` 工具调用，中断执行流并向用户提问。

**钩子**：`wrap_tool_call`

```python
class ClarificationMiddleware(AgentMiddleware[ClarificationMiddlewareState]):
    def wrap_tool_call(self, request, handler):
        if request.tool_call.get("name") != "ask_clarification":
            return handler(request)  # 非澄清调用，正常执行
        return self._handle_clarification(request)

    def _handle_clarification(self, request):
        args = request.tool_call.get("args", {})
        formatted_message = self._format_clarification_message(args)
        tool_message = ToolMessage(content=formatted_message,
                                   tool_call_id=request.tool_call.get("id"),
                                   name="ask_clarification")
        return Command(update={"messages": [tool_message]}, goto=END)
```

它必须是最后一层，因为 `Command(goto=END)` 会直接中断 Agent 的执行循环，将控制权交还给用户。如果放在其他中间件之前，后续中间件将无法执行。

## 6.4 各层依赖关系

中间件的顺序并非随意排列，存在明确的依赖链：

```
ThreadDataMiddleware (1)    ← 提供 thread_id 和路径
    ↓
UploadsMiddleware (2)       ← 依赖 thread_id 定位 uploads 目录
    ↓
SandboxMiddleware (3)       ← 依赖 thread_id 获取沙箱
    ↓
DanglingToolCallMiddleware (4) ← 无状态依赖，但必须在模型调用前修复消息
    ↓
SummarizationMiddleware (5) ← 压缩上下文，影响后续中间件看到的消息量
    ↓
TodoMiddleware (6)          ← 依赖 Summarization 的结果判断 todos 是否被截断
    ↓
TitleMiddleware (7)         ← 需要完整的首轮对话内容
    ↓
MemoryMiddleware (8)        ← 在 Title 之后，确保标题已生成
    ↓
ViewImageMiddleware (9)     ← 在 model 调用前注入图片
    ↓
SubagentLimitMiddleware (10) ← 在 model 调用后截断
    ↓
ClarificationMiddleware (11) ← 必须最后，可能中断执行
```

## 6.5 一次完整对话的中间件执行轨迹

以用户发送"帮我分析这张图片"并附带文件上传为例，描述中间件的完整执行时序：

```
[用户发送消息] ──────────────────────────────────────────────

  before_agent 阶段（按顺序执行）：
  ① ThreadDataMiddleware.before_agent  → 计算 workspace/uploads/outputs 路径
  ② UploadsMiddleware.before_agent     → 扫描上传文件，注入 <uploaded_files> 到消息
  ③ SandboxMiddleware.before_agent     → lazy 模式跳过，等待首次工具调用

  before_model 阶段（LLM 调用前）：
  ④ DanglingToolCallMiddleware.wrap_model_call → 检查并修复悬空工具调用
  ⑤ SummarizationMiddleware            → 检查 token 阈值，必要时压缩历史
  ⑥ TodoMiddleware.before_model        → 检查 todos 上下文完整性
  ⑨ ViewImageMiddleware.before_model   → 此时无图片，跳过

[LLM 生成响应：调用 view_image 工具] ──────────────────────

  after_model 阶段：
  ⑩ SubagentLimitMiddleware.after_model → 非 task 调用，跳过

  wrap_tool_call 阶段：
  ⑪ ClarificationMiddleware.wrap_tool_call → 非 ask_clarification，正常执行

  [view_image 工具执行完毕，base64 数据写入 viewed_images]

  before_model 阶段（第二轮 LLM 调用前）：
  ⑨ ViewImageMiddleware.before_model   → 检测到图片数据，注入 HumanMessage

[LLM 生成最终文字回复] ────────────────────────────────────

  after_model 阶段：
  ⑦ TitleMiddleware.aafter_model       → 首次对话，异步生成标题

  after_agent 阶段：
  ③ SandboxMiddleware.after_agent      → 释放沙箱
  ⑧ MemoryMiddleware.after_agent       → 过滤消息，提交到记忆队列
```

## 6.6 如何新增自定义 Middleware

DeerFlow 的中间件基于 LangChain 的 `AgentMiddleware` 基类。要新增自定义中间件，需要：

1. 定义状态 Schema（如果需要新的 state 字段）：

```python
class MyMiddlewareState(AgentState):
    my_field: NotRequired[str | None]
```

2. 继承 `AgentMiddleware` 并实现钩子方法：

```python
class MyMiddleware(AgentMiddleware[MyMiddlewareState]):
    state_schema = MyMiddlewareState

    def before_agent(self, state, runtime):
        """Agent 执行前调用"""
        return {"my_field": "initialized"}

    def before_model(self, state, runtime):
        """每次 LLM 调用前"""
        return None

    def after_model(self, state, runtime):
        """每次 LLM 调用后"""
        return None

    def after_agent(self, state, runtime):
        """Agent 执行完毕后"""
        return None
```

3. 在 `_build_middlewares` 中插入到合适的位置，注意依赖关系。

4. 如果新增了 state 字段，需要同步更新 `ThreadState`。

可用的钩子方法包括：`before_agent`、`after_agent`、`before_model`、`after_model`、`wrap_model_call`、`wrap_tool_call`，以及它们的异步版本（加 `a` 前缀）。

### 6.7 每层中间件的前置条件与后置操作

下表汇总了 11 层中间件各自的触发前置条件、执行后的副作用以及使用的钩子类型，便于开发者快速定位某一层的行为边界：

| 中间件 | 前置条件 | 后置操作 | 钩子类型 |
|--------|----------|----------|----------|
| ThreadDataMiddleware | `thread_id` 存在于 `runtime.context` | 写入 `thread_data`（含三条路径） | `before_agent` |
| UploadsMiddleware | `thread_data` 已就绪；最后一条为 HumanMessage | 修改 `messages`，注入 `<uploaded_files>` 块 | `before_agent` |
| SandboxMiddleware | `thread_id` 已就绪 | lazy 模式不操作；`after_agent` 释放沙箱 | `before_agent` / `after_agent` |
| DanglingToolCallMiddleware | 消息列表非空 | 在悬空 AIMessage 后插入合成 ToolMessage | `wrap_model_call` |
| SummarizationMiddleware | token 数超过配置阈值 | 替换早期消息为摘要 SystemMessage | `before_model`（内部） |
| TodoMiddleware | `is_plan_mode=True` 且 `todos` 非空 | 注入 `todo_reminder` HumanMessage | `before_model` |
| TitleMiddleware | 首次完整 user-assistant 交互完成 | 写入 `title` 字段 | `aafter_model` |
| MemoryMiddleware | `memory.enabled=True` | 过滤消息后提交到记忆队列 | `after_agent` |
| ViewImageMiddleware | 模型支持视觉；存在已完成的 `view_image` 调用 | 注入图片 base64 HumanMessage | `before_model` |
| SubagentLimitMiddleware | Subagent 模式启用 | 截断超限的 `task` 工具调用 | `after_model` |
| ClarificationMiddleware | 工具调用名为 `ask_clarification` | 返回 `Command(goto=END)` 中断执行 | `wrap_tool_call` |

从表中可以看出，`before_agent` 钩子主要负责环境准备，`before_model` / `after_model` 负责消息修补与截断，而 `wrap_*` 钩子则用于拦截和替换默认行为。

### 6.8 ThreadDataMiddleware 的目录创建逻辑

`ThreadDataMiddleware` 为每个对话线程管理三个子目录，路径统一位于 `{base_dir}/threads/{thread_id}/user-data/` 下：

```
{base_dir}/threads/{thread_id}/user-data/
├── workspace/    # 沙箱代码执行的工作区，工具在此读写文件
├── uploads/      # 用户通过前端上传的附件存放目录
└── outputs/      # 工具执行产生的输出文件（图表、CSV 等）
```

当 `lazy_init=True`（默认值）时，`before_agent` 只调用 `_get_thread_paths(thread_id)` 计算这三条路径并写入 `thread_data` 状态，**不执行任何文件系统操作**。目录的实际创建被推迟到沙箱工具首次需要读写文件时，由 `ensure_thread_directories_exist()` 函数统一完成：

```python
def ensure_thread_directories_exist(thread_data: dict):
    for key in ("workspace_dir", "uploads_dir", "outputs_dir"):
        path = thread_data.get(key)
        if path and not os.path.exists(path):
            os.makedirs(path, exist_ok=True)
```

这种惰性策略的好处在于：纯对话场景（不涉及工具调用）完全不产生磁盘 I/O；而当对话需要执行代码或处理文件时，三个目录会在同一时刻被一次性创建，避免多次零散的 `mkdir` 系统调用。

### 6.9 DanglingToolCallMiddleware 深入

"悬空工具调用"（Dangling Tool Call）是指 AIMessage 中存在 `tool_calls` 列表，但消息历史中找不到与之匹配的 `ToolMessage`。这种状态会导致大多数 LLM API 返回格式校验错误。产生悬空调用的常见场景有三种：

1. **用户中断/取消**：用户在工具执行过程中点击"停止生成"，前端向后端发送取消信号，工具执行被中止，ToolMessage 从未写入状态。
2. **服务器重启**：工具正在执行时服务进程重启，内存中的执行上下文丢失，状态中只保留了 AIMessage 而缺少对应的 ToolMessage。
3. **网络超时**：模型返回了带有 `tool_calls` 的流式响应，但后续的工具执行因网络问题超时失败，响应不完整。

修复算法的核心逻辑是**按 tool_call_id 做集合差运算**：遍历消息列表，收集所有 AIMessage 中的 `tool_call_id` 集合 A，以及所有 ToolMessage 的 `tool_call_id` 集合 B，差集 A - B 即为悬空的调用。对于每个悬空 ID，在对应的 AIMessage **紧后方**插入一条合成的 ToolMessage，其 `status="error"`、`content` 为中断提示文本。

插入位置至关重要——必须紧跟在产生该 tool_call 的 AIMessage 之后，而不是追加到消息列表末尾。这是该中间件选择 `wrap_model_call` 钩子而非 `before_model` 钩子的根本原因：`before_model` 只能向 `messages` 列表末尾追加新消息，无法在任意位置插入。

### 6.10 ClarificationMiddleware 的 Command(goto=END) 原理

当 `ClarificationMiddleware` 检测到 `ask_clarification` 工具调用时，它不会将请求传递给真正的工具执行器，而是返回一个 `Command` 对象：

```python
return Command(update={"messages": [tool_message]}, goto=END)
```

`Command` 是 LangGraph 提供的流程控制原语。`goto=END` 告诉图执行引擎：**立即跳转到 END 节点，不再执行当前节点的后续逻辑，也不再进入下一个节点**。这等价于在 ReAct 循环中插入了一个强制退出点。

具体的执行流程如下：LLM 返回一条包含 `ask_clarification` 工具调用的 AIMessage → 图引擎将该调用分发到 `wrap_tool_call` 钩子链 → `ClarificationMiddleware` 拦截该调用 → 构造一条格式化的 ToolMessage（包含向用户提出的问题）→ 将该 ToolMessage 通过 `Command.update` 写入状态 → `goto=END` 使图引擎跳过所有剩余节点直接终止。

关键细节在于：虽然执行流被中断，但 ToolMessage **仍然被写入了状态**。这意味着前端可以从状态中读取到这条消息并渲染给用户。当用户回答后，新一轮对话会携带完整的消息历史（包括那条 ToolMessage），LLM 因此知道之前的澄清问题已被回答，可以继续正常推理。

### 6.11 中间件依赖关系表

下表详细列出每层中间件对前置中间件的具体依赖及其原因，解释了为何 `_build_middlewares` 中的排列顺序是强制性的：

| 中间件 | 依赖的前置中间件 | 依赖原因 |
|--------|-----------------|----------|
| UploadsMiddleware | ThreadDataMiddleware | 需要 `thread_data.uploads_dir` 路径来扫描历史上传文件 |
| SandboxMiddleware | ThreadDataMiddleware | 需要 `thread_id` 来分配和标识沙箱实例 |
| DanglingToolCallMiddleware | UploadsMiddleware | 必须在消息被修改（注入 `<uploaded_files>`）之后运行，否则修复的消息可能被覆盖 |
| SummarizationMiddleware | DanglingToolCallMiddleware | 摘要前消息列表必须格式完整，不能包含悬空调用 |
| TodoMiddleware | SummarizationMiddleware | 需要判断 `write_todos` 调用是否被摘要截断，必须在摘要之后检查 |
| TitleMiddleware | 无强依赖 | 但需要完整的首轮消息，放在摘要之后确保消息格式稳定 |
| MemoryMiddleware | TitleMiddleware | 可选地将标题作为记忆上下文的一部分；且需要在标题生成后再提交 |
| ViewImageMiddleware | 无强依赖 | 独立检查 `view_image` 工具结果，但需在 model 调用前注入 |
| SubagentLimitMiddleware | 无强依赖 | 在 model 调用后截断，不影响其他中间件的 before_model 逻辑 |
| ClarificationMiddleware | 所有其他中间件 | `Command(goto=END)` 会中断整个执行流，必须确保其他中间件已执行完毕 |

从表中可以看出，前四层形成了严格的线性依赖链（ThreadData → Uploads → Sandbox → Dangling），中间层的依赖相对松散，而 ClarificationMiddleware 作为"终结者"必须排在最末。

### 6.12 一次完整对话的中间件执行时序

以下用 ASCII 时序图展示一次包含工具调用的完整对话中，各中间件的精确触发顺序与数据流向：

```
时间 ──────────────────────────────────────────────────────────────────────►
│
├─ [T0] 用户消息到达
│  ├─ ThreadDataMiddleware.before_agent    → 计算 workspace/uploads/outputs 三条路径
│  │                                         写入 state.thread_data
│  ├─ UploadsMiddleware.before_agent       → 扫描 uploads_dir，发现 2 个文件
│  │                                         注入 <uploaded_files> 到 HumanMessage
│  └─ SandboxMiddleware.before_agent       → lazy_init=True, 跳过沙箱分配
│
├─ [T1] 第一轮 LLM 调用（before_model 阶段）
│  ├─ DanglingToolCallMiddleware           → 扫描消息历史，发现 1 个悬空调用
│  │   .wrap_model_call                      在 AIMessage 后插入合成 ToolMessage
│  ├─ SummarizationMiddleware              → token 数 2048 < 阈值 4096, 跳过
│  ├─ TodoMiddleware.before_model          → 非 Plan Mode 或无 todos, 跳过
│  └─ ViewImageMiddleware.before_model     → 无 view_image 结果, 跳过
│
├─ [T2] LLM 返回响应（包含 tool_calls: [run_code, task]）
│  ├─ SubagentLimitMiddleware.after_model  → 检查 task 调用数: 1 ≤ max(3), 放行
│  └─ TitleMiddleware.aafter_model         → 首次交互，异步调用轻量模型生成标题
│                                             写入 state.title = "数据分析报告"
│
├─ [T3] 工具执行阶段
│  ├─ ClarificationMiddleware              → run_code: 非 ask_clarification, 放行
│  │   .wrap_tool_call                       task: 非 ask_clarification, 放行
│  ├─ ensure_thread_directories_exist()    → 首次工具调用，创建三个子目录
│  │                                         mkdir workspace/ uploads/ outputs/
│  └─ SandboxMiddleware                    → 首次需要沙箱，调用 _acquire_sandbox()
│                                             分配沙箱 ID 并写入 state.sandbox
│
├─ [T4] 第二轮 LLM 调用（工具结果已返回）
│  ├─ DanglingToolCallMiddleware           → 扫描消息历史，无悬空调用
│  │   .wrap_model_call
│  ├─ SummarizationMiddleware              → token 数 3200 < 阈值 4096, 跳过
│  ├─ TodoMiddleware.before_model          → 跳过
│  └─ ViewImageMiddleware.before_model     → 跳过
│
├─ [T5] LLM 返回最终文字回复（无 tool_calls）
│  ├─ SubagentLimitMiddleware.after_model  → 无 tool_calls, 跳过
│  └─ TitleMiddleware.aafter_model         → 标题已生成, 跳过
│
└─ [T6] Agent 执行结束（after_agent 阶段）
   ├─ SandboxMiddleware.after_agent        → 释放沙箱: release(sandbox_id)
   └─ MemoryMiddleware.after_agent         → 过滤工具消息和 <uploaded_files>
                                              提交 [HumanMessage, AIMessage] 到记忆队列
```

这张时序图清晰地展示了几个关键特征：**before_agent 钩子只在 T0 执行一次**，而 **before_model/after_model 钩子在每轮 LLM 调用时都会重新执行**（T1-T2、T4-T5）；沙箱和目录的创建被推迟到 T3 工具实际执行时；ClarificationMiddleware 在每次工具调用时都参与检查，但只有遇到 `ask_clarification` 时才会真正拦截。

## 小结

DeerFlow 的 11 层中间件管道是其架构中最精巧的部分之一：

1. **关注点分离**：每层中间件只处理一个横切关注点，代码清晰、可测试。
2. **顺序即契约**：中间件的排列顺序编码了它们之间的依赖关系，源码注释中有详尽说明。
3. **条件组装**：只有 4 层是固定的（ThreadData、Uploads、Sandbox、Dangling），其余 7 层根据运行时配置动态启用。
4. **多种钩子点**：`before/after_agent`、`before/after_model`、`wrap_model_call`、`wrap_tool_call` 覆盖了 Agent 生命周期的每个阶段。
5. **ClarificationMiddleware 必须殿后**：它可能直接中断执行流，因此必须是最后一层。

理解中间件管道，就理解了 DeerFlow 如何在不污染核心逻辑的前提下，优雅地处理环境初始化、上下文管理、资源回收等系统级任务。
