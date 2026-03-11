# 第 12 章　记忆更新流水线

上一章我们剖析了记忆的数据结构和配置体系。但一个关键问题尚未回答：对话结束后，记忆究竟是如何被更新的？答案是一条精心设计的异步流水线——从 `MemoryMiddleware` 捕获对话、到 `MemoryUpdateQueue` 防抖去重、再到 `MemoryUpdater` 调用 LLM 抽取并原子写入。本章将沿着这条流水线逐步展开。

## 12.1 MemoryMiddleware：对话的捕获者

记忆更新的起点在 `MemoryMiddleware.after_agent` 方法。每当 Agent 完成一轮执行，中间件自动触发：

```python
class MemoryMiddleware(AgentMiddleware[MemoryMiddlewareState]):
    @override
    def after_agent(self, state: MemoryMiddlewareState, runtime: Runtime) -> dict | None:
        config = get_memory_config()
        if not config.enabled:
            return None

        thread_id = runtime.context.get("thread_id")
        if not thread_id:
            return None

        messages = state.get("messages", [])
        if not messages:
            return None

        # 过滤：只保留用户输入和最终回复
        filtered_messages = _filter_messages_for_memory(messages)

        user_messages = [m for m in filtered_messages if getattr(m, "type", None) == "human"]
        assistant_messages = [m for m in filtered_messages if getattr(m, "type", None) == "ai"]

        if not user_messages or not assistant_messages:
            return None

        # 入队
        queue = get_memory_queue()
        queue.add(thread_id=thread_id, messages=filtered_messages, agent_name=self._agent_name)
        return None
```

这里有两个重要的设计决策。

**第一，消息过滤。** `_filter_messages_for_memory` 剔除了所有工具调用消息（tool messages）和带 `tool_calls` 的 AI 消息。只有用户的原始输入和 Agent 的最终回复才会进入记忆流水线。这避免了将中间推理步骤（如搜索结果、代码执行输出）当作用户特征来记忆。

**第二，上传文件清洗。** 由 `UploadsMiddleware` 注入的 `<uploaded_files>` 块会被正则清除。上传文件是会话级别的临时资源，如果写入长期记忆，未来的对话中 Agent 会试图访问已不存在的文件路径：

```python
_UPLOAD_BLOCK_RE = re.compile(r"<uploaded_files>[\s\S]*?</uploaded_files>\n*", re.IGNORECASE)
```

## 12.2 Memory Queue：防抖与并发控制

过滤后的对话不会立即触发 LLM 更新，而是进入 `MemoryUpdateQueue`。这个队列解决了两个问题：频繁更新的性能开销，以及并发写入的数据竞争。

```python
class MemoryUpdateQueue:
    def __init__(self):
        self._queue: list[ConversationContext] = []
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self._processing = False
```

### 防抖机制

每次 `add()` 调用都会重置一个定时器。只有在 `debounce_seconds`（默认 30 秒）内没有新的对话入队时，队列才开始处理：

```python
def add(self, thread_id: str, messages: list[Any], agent_name: str | None = None) -> None:
    config = get_memory_config()
    if not config.enabled:
        return

    context = ConversationContext(
        thread_id=thread_id,
        messages=messages,
        agent_name=agent_name,
    )

    with self._lock:
        # 同一 thread 的新消息替换旧消息
        self._queue = [c for c in self._queue if c.thread_id != thread_id]
        self._queue.append(context)
        self._reset_timer()
```

注意同一 `thread_id` 的旧条目会被新条目替换。这意味着在快速连续对话时，只有最新的完整对话历史会被用于记忆更新，避免了重复处理。

### 定时器重置

```python
def _reset_timer(self) -> None:
    config = get_memory_config()
    if self._timer is not None:
        self._timer.cancel()
    self._timer = threading.Timer(
        config.debounce_seconds,
        self._process_queue,
    )
    self._timer.daemon = True
    self._timer.start()
```

定时器设为 daemon 线程，应用退出时不会阻塞。如果需要立即处理（如测试场景或优雅关闭），可以调用 `flush()` 方法。

### 并发保护

队列处理时通过 `_processing` 标志位防止重入：

```python
def _process_queue(self) -> None:
    with self._lock:
        if self._processing:
            self._reset_timer()
            return
        if not self._queue:
            return
        self._processing = True
        contexts_to_process = self._queue.copy()
        self._queue.clear()
        self._timer = None

    try:
        updater = MemoryUpdater()
        for context in contexts_to_process:
            success = updater.update_memory(
                messages=context.messages,
                thread_id=context.thread_id,
                agent_name=context.agent_name,
            )
            # 多条更新之间加小延迟，避免 LLM 限流
            if len(contexts_to_process) > 1:
                time.sleep(0.5)
    finally:
        with self._lock:
            self._processing = False
```

`_queue.copy()` + `_queue.clear()` 的模式确保了处理期间新入队的消息不会丢失——它们会在下一轮处理中被消费。

## 12.3 MemoryUpdater：LLM 抽取与合并

队列处理的核心是 `MemoryUpdater.update_memory`。这个方法编排了一条完整的管道：

1. **读取当前记忆** → `get_memory_data()`
2. **格式化对话** → `format_conversation_for_update(messages)`
3. **构建 Prompt** → 将当前记忆 + 对话填入 `MEMORY_UPDATE_PROMPT` 模板
4. **调用 LLM** → 返回 JSON 格式的更新指令
5. **应用更新** → `_apply_updates()` 合并到现有记忆
6. **清洗上传痕迹** → `_strip_upload_mentions_from_memory()`
7. **原子写入** → `_save_memory_to_file()`

其中 `format_conversation_for_update` 将消息列表转换为简洁的文本格式：

```python
def format_conversation_for_update(messages: list[Any]) -> str:
    lines = []
    for msg in messages:
        role = getattr(msg, "type", "unknown")
        content = getattr(msg, "content", str(msg))
        # 截断过长消息
        if len(str(content)) > 1000:
            content = str(content)[:1000] + "..."
        if role == "human":
            lines.append(f"User: {content}")
        elif role == "ai":
            lines.append(f"Assistant: {content}")
    return "\n\n".join(lines)
```

## 12.4 原子写入

记忆写入采用了经典的"写临时文件 + rename"模式，保证了即使进程在写入过程中崩溃，也不会留下损坏的 JSON 文件：

```python
def _save_memory_to_file(memory_data: dict[str, Any], agent_name: str | None = None) -> bool:
    file_path = _get_memory_file_path(agent_name)
    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        memory_data["lastUpdated"] = datetime.utcnow().isoformat() + "Z"

        # 先写临时文件
        temp_path = file_path.with_suffix(".tmp")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(memory_data, f, indent=2, ensure_ascii=False)

        # rename 是大多数文件系统上的原子操作
        temp_path.replace(file_path)

        # 更新内存缓存
        try:
            mtime = file_path.stat().st_mtime
        except OSError:
            mtime = None
        _memory_cache[agent_name] = (memory_data, mtime)
        return True
    except OSError as e:
        print(f"Failed to save memory file: {e}")
        return False
```

`ensure_ascii=False` 确保中文等非 ASCII 字符以原始形式存储，而非转义序列。

## 12.5 全局单例与生命周期

`MemoryUpdateQueue` 通过全局单例模式管理：

```python
_memory_queue: MemoryUpdateQueue | None = None
_queue_lock = threading.Lock()

def get_memory_queue() -> MemoryUpdateQueue:
    global _memory_queue
    with _queue_lock:
        if _memory_queue is None:
            _memory_queue = MemoryUpdateQueue()
        return _memory_queue
```

双重锁保护（`_queue_lock` 保护单例创建，`_lock` 保护队列内部操作）确保了多线程环境下的安全性。

## 12.6 实战：连续对话后 memory.json 的变化

假设用户与 DeerFlow 进行了三轮对话：

1. "我在字节跳动做后端开发，主要用 Go 和 Python。"
2. "帮我分析一下 DeerFlow 的记忆系统架构。"
3. "我计划下个季度把团队的 CI/CD 迁移到 GitHub Actions。"

30 秒防抖结束后，LLM 分析这三轮对话，`memory.json` 可能产生如下变化：

```json
{
  "version": "1.0",
  "lastUpdated": "2026-03-12T10:30:00Z",
  "user": {
    "workContext": {
      "summary": "字节跳动后端开发工程师，主要使用 Go 和 Python 技术栈。",
      "updatedAt": "2026-03-12T10:30:00Z"
    },
    "topOfMind": {
      "summary": "正在研究 DeerFlow 的记忆系统架构。计划下个季度将团队的 CI/CD 迁移到 GitHub Actions。",
      "updatedAt": "2026-03-12T10:30:00Z"
    }
  },
  "facts": [
    {
      "id": "fact_a1b2c3d4",
      "content": "在字节跳动担任后端开发工程师",
      "category": "context",
      "confidence": 0.95,
      "createdAt": "2026-03-12T10:30:00Z",
      "source": "thread_abc123"
    },
    {
      "id": "fact_e5f6g7h8",
      "content": "计划将团队 CI/CD 迁移到 GitHub Actions",
      "category": "goal",
      "confidence": 0.9,
      "createdAt": "2026-03-12T10:30:00Z",
      "source": "thread_abc123"
    }
  ]
}
```

下次对话开始时，Agent 的系统提示词中会注入这些记忆，使其能够直接以"你好，上次你提到计划迁移 CI/CD 到 GitHub Actions，进展如何？"这样的方式开场。

## 小结

DeerFlow 的记忆更新流水线体现了工程上的严谨。`MemoryMiddleware` 在 Agent 执行后自动捕获对话，同时过滤掉工具调用和临时上传信息。`MemoryUpdateQueue` 通过 30 秒防抖和同 thread 去重，将频繁的对话批量处理，避免了不必要的 LLM 调用。`MemoryUpdater` 将当前记忆与新对话一起交给 LLM，由模型决定哪些 summary 需要更新、哪些 facts 需要新增或删除。最后，原子写入保证了数据一致性。整条流水线完全异步，不会阻塞用户的交互体验。
