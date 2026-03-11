# 第 10 章　SubagentExecutor：执行引擎

上一章从架构层面介绍了 Sub-Agent 的整体设计。本章将深入 `SubagentExecutor` 的实现细节，剖析它如何通过双线程池架构、状态机管理和超时控制来可靠地执行子任务。

所有核心代码都集中在 `backend/src/subagents/executor.py` 这一个文件中，代码量不到 500 行，但麻雀虽小五脏俱全。

## 10.1 SubagentStatus 状态机

每个 Sub-Agent 任务都有一个明确的生命周期，由 `SubagentStatus` 枚举定义：

```python
class SubagentStatus(Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMED_OUT = "timed_out"
```

状态转换路径如下：

```
PENDING → RUNNING → COMPLETED
                  → FAILED
                  → TIMED_OUT
```

`PENDING` 表示任务已提交但尚未开始执行；`RUNNING` 表示已进入执行线程池；三个终态分别对应成功完成、执行异常和超时中断。

这种设计确保了每个任务在任何时刻都有一个确定的状态，避免了状态模糊导致的并发问题。

## 10.2 SubagentResult 数据结构

`SubagentResult` 是 Sub-Agent 执行的完整记录：

```python
@dataclass
class SubagentResult:
    task_id: str
    trace_id: str
    status: SubagentStatus
    result: str | None = None
    error: str | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None
    ai_messages: list[dict[str, Any]] | None = None

    def __post_init__(self):
        if self.ai_messages is None:
            self.ai_messages = []
```

几个关键字段的用途：

- `task_id`：唯一任务标识，由 `tool_call_id` 传入，便于与 Lead Agent 的工具调用关联
- `trace_id`：分布式追踪 ID，贯穿父子 Agent 的所有日志
- `ai_messages`：执行过程中产生的所有 AI 消息列表，用于向前端实时推送进度
- `started_at` / `completed_at`：时间戳，用于性能分析和超时判断

注意 `__post_init__` 中对 `ai_messages` 的处理——这是 Python dataclass 处理可变默认值的标准做法，避免了多个实例共享同一个列表对象的经典陷阱。

## 10.3 双线程池架构

`SubagentExecutor` 最具特色的设计是双线程池分离：

```python
# 调度线程池：负责任务编排和超时控制
_scheduler_pool = ThreadPoolExecutor(
    max_workers=3, thread_name_prefix="subagent-scheduler-"
)

# 执行线程池：负责实际的 Agent 执行
_execution_pool = ThreadPoolExecutor(
    max_workers=3, thread_name_prefix="subagent-exec-"
)
```

为什么需要两个线程池？因为超时控制需要一个"看门人"。如果调度和执行在同一个线程中，当执行超时时没有第二个线程来中断它。双线程池的工作流程是：

1. `task_tool` 调用 `execute_async()`，将任务提交到 **scheduler 池**
2. scheduler 线程将任务提交到 **execution 池**，并调用 `future.result(timeout=...)` 等待
3. 如果 execution 线程在超时时间内完成，scheduler 收集结果
4. 如果超时，scheduler 捕获 `FuturesTimeoutError`，将状态设为 `TIMED_OUT`

来看 `execute_async` 的核心逻辑：

```python
def execute_async(self, task: str, task_id: str | None = None) -> str:
    if task_id is None:
        task_id = str(uuid.uuid4())[:8]

    result = SubagentResult(
        task_id=task_id,
        trace_id=self.trace_id,
        status=SubagentStatus.PENDING,
    )

    with _background_tasks_lock:
        _background_tasks[task_id] = result

    def run_task():
        with _background_tasks_lock:
            _background_tasks[task_id].status = SubagentStatus.RUNNING
            _background_tasks[task_id].started_at = datetime.now()
            result_holder = _background_tasks[task_id]

        try:
            execution_future: Future = _execution_pool.submit(
                self.execute, task, result_holder
            )
            try:
                exec_result = execution_future.result(
                    timeout=self.config.timeout_seconds
                )
                with _background_tasks_lock:
                    _background_tasks[task_id].status = exec_result.status
                    _background_tasks[task_id].result = exec_result.result
                    _background_tasks[task_id].error = exec_result.error
                    _background_tasks[task_id].completed_at = datetime.now()
                    _background_tasks[task_id].ai_messages = exec_result.ai_messages
            except FuturesTimeoutError:
                with _background_tasks_lock:
                    _background_tasks[task_id].status = SubagentStatus.TIMED_OUT
                    _background_tasks[task_id].error = (
                        f"Execution timed out after "
                        f"{self.config.timeout_seconds} seconds"
                    )
                    _background_tasks[task_id].completed_at = datetime.now()
                execution_future.cancel()
        except Exception as e:
            with _background_tasks_lock:
                _background_tasks[task_id].status = SubagentStatus.FAILED
                _background_tasks[task_id].error = str(e)
                _background_tasks[task_id].completed_at = datetime.now()

    _scheduler_pool.submit(run_task)
    return task_id
```

整个流程中，`_background_tasks_lock` 确保了对共享状态字典的线程安全访问。每次状态更新都在锁内完成，避免了读写竞争。

## 10.4 同步执行与异步桥接

`execute` 方法是同步与异步的桥接层：

```python
def execute(self, task: str, result_holder: SubagentResult | None = None) -> SubagentResult:
    try:
        return asyncio.run(self._aexecute(task, result_holder))
    except Exception as e:
        logger.exception(f"[trace={self.trace_id}] execution failed")
        if result_holder is not None:
            result = result_holder
        else:
            result = SubagentResult(
                task_id=str(uuid.uuid4())[:8],
                trace_id=self.trace_id,
                status=SubagentStatus.FAILED,
            )
        result.status = SubagentStatus.FAILED
        result.error = str(e)
        result.completed_at = datetime.now()
        return result
```

这里使用 `asyncio.run()` 而非 `await`，因为执行线程池中的线程没有事件循环。`asyncio.run()` 会创建一个全新的事件循环来运行异步代码，这使得 Sub-Agent 可以使用异步工具（如 MCP 工具）。

`_aexecute` 方法使用 `astream` 以流式方式获取 Agent 的执行过程，每产生一条新的 `AIMessage` 就追加到 `result.ai_messages` 列表中。由于 `result_holder` 是从全局 `_background_tasks` 字典中取出的引用，更新会实时反映到轮询方查看的数据中。

## 10.5 任务轮询与进度推送

`task_tool` 中的轮询循环每 5 秒检查一次任务状态：

```python
while True:
    result = get_background_task_result(task_id)
    # ...检查新消息，推送 task_running 事件...

    if result.status == SubagentStatus.COMPLETED:
        writer({"type": "task_completed", "task_id": task_id, "result": result.result})
        cleanup_background_task(task_id)
        return f"Task Succeeded. Result: {result.result}"
    elif result.status == SubagentStatus.FAILED:
        # ...
    elif result.status == SubagentStatus.TIMED_OUT:
        # ...

    time.sleep(5)
    poll_count += 1

    if poll_count > max_poll_count:
        # 安全网：防止线程池超时机制失效时无限等待
        return f"Task polling timed out..."
```

轮询过程中，每当检测到新的 AI 消息，会通过 `stream_writer` 向前端推送 `task_running` 事件，实现实时进度展示。`max_poll_count` 作为安全网，设置为 `(timeout_seconds + 60) / 5`，在执行超时加 60 秒缓冲后强制结束轮询。

## 10.6 Background Task 清理

为防止内存泄漏，完成的任务需要从全局字典中清除：

```python
def cleanup_background_task(task_id: str) -> None:
    with _background_tasks_lock:
        result = _background_tasks.get(task_id)
        if result is None:
            return

        is_terminal_status = result.status in {
            SubagentStatus.COMPLETED,
            SubagentStatus.FAILED,
            SubagentStatus.TIMED_OUT,
        }
        if is_terminal_status or result.completed_at is not None:
            del _background_tasks[task_id]
```

清理只在终态时执行，这个检查避免了一种竞态条件：如果轮询线程在 scheduler 线程更新状态之前就尝试清理，可能会删除一个仍在运行的任务条目。通过检查是否处于终态，确保了清理操作的安全性。

## 10.7 错误处理的三层防护

Sub-Agent 的错误处理设计了三层防护网：

1. **Agent 执行层**（`_aexecute`）：`try-except` 捕获 Agent 运行中的所有异常，设置 `FAILED` 状态
2. **事件循环层**（`execute`）：捕获 `asyncio.run()` 自身的失败，如在已有事件循环的上下文中调用
3. **调度层**（`execute_async` 中的 `run_task`）：捕获线程提交和超时相关的异常

无论异常发生在哪一层，最终都会被正确记录到 `SubagentResult` 中，保证 `task_tool` 的轮询循环一定能收到一个终态结果。

## 小结

`SubagentExecutor` 的实现虽然紧凑，但在可靠性方面做了充分的考量：

- 双线程池分离调度与执行，使超时控制成为可能
- 五状态机（PENDING / RUNNING / COMPLETED / FAILED / TIMED_OUT）覆盖了所有生命周期
- `SubagentResult` 承载执行的完整记录，包括实时 AI 消息
- `asyncio.run()` 桥接同步线程池与异步 Agent 执行
- 全局字典 + 线程锁实现线程安全的状态共享
- 三层错误处理确保任何异常都不会导致任务"消失"
- 终态检查的清理机制防止内存泄漏和竞态条件

下一章将跳出执行引擎的视角，看看 Lead Agent 如何通过 Middleware 和 Prompt 工程来编排多个 Sub-Agent 的并发调度。
