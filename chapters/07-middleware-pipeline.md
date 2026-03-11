# 第 7 章　11 层中间件管道：Agent 的神经系统

如果 Lead Agent 是大脑，那么中间件管道就是它的神经系统。DeerFlow 通过最多 11 层中间件处理所有 Cross-cutting Concerns——从沙箱环境初始化到对话摘要，从悬空工具调用修复到澄清请求拦截。本章逐一拆解每一层中间件的源码与设计意图。

## 7.1 为什么需要中间件

Agent 的核心逻辑是"接收消息 -> 调用模型 -> 执行工具 -> 返回结果"。但在这个主循环之外，有大量的横切关注点（Cross-cutting Concerns）需要处理：

- 每次对话需要创建沙箱目录
- 用户上传的文件需要注入到消息上下文
- 对话过长时需要自动摘要
- 模型可能生成悬空的工具调用
- 首次对话后需要自动生成标题

如果把这些逻辑全部写在主循环中，代码会迅速膨胀且难以维护。中间件模式将这些关注点解耦为独立的、可组合的层，每一层只关心自己的职责。

## 7.2 中间件链的构建

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

## 7.3 完整的 11 层中间件

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

## 7.4 各层依赖关系

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

## 7.5 一次完整对话的中间件执行轨迹

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

## 7.6 如何新增自定义 Middleware

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

## 小结

DeerFlow 的 11 层中间件管道是其架构中最精巧的部分之一：

1. **关注点分离**：每层中间件只处理一个横切关注点，代码清晰、可测试。
2. **顺序即契约**：中间件的排列顺序编码了它们之间的依赖关系，源码注释中有详尽说明。
3. **条件组装**：只有 4 层是固定的（ThreadData、Uploads、Sandbox、Dangling），其余 7 层根据运行时配置动态启用。
4. **多种钩子点**：`before/after_agent`、`before/after_model`、`wrap_model_call`、`wrap_tool_call` 覆盖了 Agent 生命周期的每个阶段。
5. **ClarificationMiddleware 必须殿后**：它可能直接中断执行流，因此必须是最后一层。

理解中间件管道，就理解了 DeerFlow 如何在不污染核心逻辑的前提下，优雅地处理环境初始化、上下文管理、资源回收等系统级任务。
