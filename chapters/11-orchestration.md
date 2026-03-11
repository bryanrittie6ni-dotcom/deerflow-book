# 第 11 章　并发调度与 Orchestration 策略

前两章分别介绍了 Sub-Agent 的架构设计和执行引擎。本章将聚焦于一个核心问题：Lead Agent 如何正确地将复杂任务分解为多个子任务，并在并发限制下高效执行？

答案藏在两个地方：`SubagentLimitMiddleware` 提供硬性约束，System Prompt 中的 Orchestration 提示词提供软性引导。两者协同工作，构成了 DeerFlow 的并发调度体系。

## 11.1 SubagentLimitMiddleware：硬限制

LLM 并不总是严格遵守 prompt 中的指令。当模型一次生成超过 3 个 `task` 调用时，必须有一道硬性防线。`SubagentLimitMiddleware` 正是这道防线：

```python
class SubagentLimitMiddleware(AgentMiddleware[AgentState]):
    """Truncates excess 'task' tool calls from a single model response."""

    def __init__(self, max_concurrent: int = MAX_CONCURRENT_SUBAGENTS):
        super().__init__()
        self.max_concurrent = _clamp_subagent_limit(max_concurrent)

    def _truncate_task_calls(self, state: AgentState) -> dict | None:
        messages = state.get("messages", [])
        if not messages:
            return None

        last_msg = messages[-1]
        if getattr(last_msg, "type", None) != "ai":
            return None

        tool_calls = getattr(last_msg, "tool_calls", None)
        if not tool_calls:
            return None

        # 统计 task 工具调用
        task_indices = [
            i for i, tc in enumerate(tool_calls)
            if tc.get("name") == "task"
        ]
        if len(task_indices) <= self.max_concurrent:
            return None

        # 保留前 max_concurrent 个，丢弃多余的
        indices_to_drop = set(task_indices[self.max_concurrent:])
        truncated_tool_calls = [
            tc for i, tc in enumerate(tool_calls)
            if i not in indices_to_drop
        ]

        dropped_count = len(indices_to_drop)
        logger.warning(
            f"Truncated {dropped_count} excess task tool call(s) "
            f"(limit: {self.max_concurrent})"
        )

        updated_msg = last_msg.model_copy(
            update={"tool_calls": truncated_tool_calls}
        )
        return {"messages": [updated_msg]}

    @override
    def after_model(self, state, runtime) -> dict | None:
        return self._truncate_task_calls(state)
```

几个值得注意的设计细节：

**只截断 task 调用，保留其他工具调用**。如果模型同时生成了 5 个 `task` 调用和 2 个 `read_file` 调用，只有超出限制的 `task` 调用会被丢弃，`read_file` 调用不受影响。

**限制值被钳位到 [2, 4] 范围**：

```python
MIN_SUBAGENT_LIMIT = 2
MAX_SUBAGENT_LIMIT = 4

def _clamp_subagent_limit(value: int) -> int:
    return max(MIN_SUBAGENT_LIMIT, min(MAX_SUBAGENT_LIMIT, value))
```

即使配置写了 `max_concurrent=10`，实际也会被限制在 4 个。这是一种防御性设计，避免资源耗尽。

**`after_model` 钩子**：Middleware 在模型生成响应后、工具执行前介入，此时截断多余的调用是最佳时机——工具还没开始执行，不会造成资源浪费。

## 11.2 Prompt 工程：引导 LLM 正确分解任务

硬限制只是最后一道防线，真正的编排智慧来自 System Prompt 中的 `<subagent_system>` 部分。这段提示词经过精心设计，教会 LLM 如何做一个好的任务编排者。

### 核心指令框架

```python
def _build_subagent_section(max_concurrent: int) -> str:
    n = max_concurrent
    return f"""<subagent_system>
**SUBAGENT MODE ACTIVE - DECOMPOSE, DELEGATE, SYNTHESIZE**

You are running with subagent capabilities enabled.
Your role is to be a **task orchestrator**:
1. **DECOMPOSE**: Break complex tasks into parallel sub-tasks
2. **DELEGATE**: Launch multiple subagents simultaneously
3. **SYNTHESIZE**: Collect and integrate results
```

三步工作流——分解、委派、综合——清晰地定义了 Lead Agent 的角色。

### 并发限制的反复强调

提示词中对并发限制进行了多次、多角度的强调：

```
**HARD CONCURRENCY LIMIT: MAXIMUM {n} `task` CALLS PER RESPONSE.**
- Each response, you may include at most {n} task tool calls.
  Any excess calls are silently discarded by the system.
- Before launching subagents, you MUST count your sub-tasks
  in your thinking.
```

"silently discarded"这个措辞是经过考量的——告诉模型超出的调用会被丢弃（而不是报错），促使它主动控制数量而非依赖错误重试。

### 多批次执行策略

当子任务超过并发限制时，提示词给出了明确的多批次模式：

```
**Multi-batch execution** (for >{n} sub-tasks):
  - Turn 1: Launch sub-tasks 1-{n} in parallel → wait for results
  - Turn 2: Launch next batch in parallel → wait for results
  - ... continue until all sub-tasks are complete
  - Final turn: Synthesize ALL results into a coherent answer
```

并配合思维模式引导：

```
**Example thinking pattern**: "I identified 6 sub-tasks.
Since the limit is {n} per turn, I will launch the first {n}
now, and the rest in the next turn."
```

这种"先想后做"的引导非常有效，因为它利用了 LLM 的思维链（Chain-of-Thought）能力来约束行为。

### 何时使用、何时不使用

提示词还明确列出了适用和不适用的场景：

```
USE Parallel Subagents when:
- Complex research questions
- Multi-aspect analysis
- Large codebases
- Comprehensive investigations

DO NOT use subagents when:
- Task cannot be decomposed
- Ultra-simple actions
- Need immediate clarification
- Sequential dependencies
```

最后一条特别重要：如果步骤之间有依赖关系，不应该并行化，而应该由 Lead Agent 自己顺序执行。

## 11.3 max_concurrent 与 Middleware 的协同

`max_concurrent` 参数在创建 Lead Agent 时传入，同时影响 Prompt 和 Middleware：

```python
def apply_prompt_template(
    subagent_enabled: bool = False,
    max_concurrent_subagents: int = 3,
    *,
    agent_name: str | None = None,
) -> str:
    n = max_concurrent_subagents
    subagent_section = _build_subagent_section(n) if subagent_enabled else ""
    # ...prompt 中的 {n} 会被替换为实际数字
```

Prompt 中的 `{n}` 和 Middleware 的 `max_concurrent` 使用相同的值。这保证了"软引导"和"硬截断"对齐——模型被告知限制是 3，Middleware 也按 3 来截断。如果两者不一致，模型可能会因为被截断而困惑，导致不可预期的行为。

## 11.4 实战案例：3 个子 Agent 并行分析 5 个竞品

假设用户问："帮我对比分析 AWS、Azure、GCP、阿里云和 Oracle Cloud 这 5 个云平台。"

Lead Agent 的编排过程如下：

**第一轮（Turn 1）**：Lead Agent 在思维链中分析——"5 个子任务，限制 3 个，需要分两批。"

```python
# 第一批：启动 3 个 Sub-Agent
task(description="AWS 分析", prompt="详细分析 AWS 的核心服务、定价策略、市场份额...", subagent_type="general-purpose")
task(description="Azure 分析", prompt="详细分析 Azure 的核心服务、定价策略、市场份额...", subagent_type="general-purpose")
task(description="GCP 分析", prompt="详细分析 GCP 的核心服务、定价策略、市场份额...", subagent_type="general-purpose")
```

三个 Sub-Agent 进入 scheduler 池，分别被提交到 execution 池并行执行。`task_tool` 的轮询循环每 5 秒检查状态，向前端推送 `task_running` 进度事件。

**第二轮（Turn 2）**：前 3 个任务完成后，Lead Agent 启动剩余的 2 个：

```python
# 第二批：启动剩余 2 个 Sub-Agent
task(description="阿里云分析", prompt="详细分析阿里云的核心服务、定价策略、市场份额...", subagent_type="general-purpose")
task(description="Oracle Cloud 分析", prompt="详细分析 Oracle Cloud 的核心服务、定价策略...", subagent_type="general-purpose")
```

**第三轮（Turn 3）**：所有 5 个子任务完成，Lead Agent 综合所有结果，生成对比分析报告。

整个过程中，如果 Lead Agent 在第一轮就尝试启动 5 个 `task` 调用，`SubagentLimitMiddleware` 会截断为 3 个，并在日志中记录警告。

## 11.5 实战案例：并行调研 10 篇论文

另一个典型场景："帮我调研这 10 篇深度学习论文的核心贡献。"

Lead Agent 的批次规划：

```
思考：10 篇论文 → 10 个子任务 → 需要 4 批
  批次 1（本轮）：论文 1-3
  批次 2（下一轮）：论文 4-6
  批次 3（再下一轮）：论文 7-9
  批次 4（最后一批）：论文 10
  综合轮：汇总所有结果
```

每一批内的 Sub-Agent 并行执行，批次间顺序执行。这样既充分利用了并发能力，又不会超过系统限制。

对于每篇论文的子任务，prompt 需要足够具体：

```python
task(
    description="ResNet 论文分析",
    prompt="""分析论文 'Deep Residual Learning for Image Recognition':
    1. 核心贡献和创新点
    2. 技术方法概要
    3. 实验结果和关键数据
    4. 对后续工作的影响
    使用 web_search 搜索论文信息，并提供引用链接。""",
    subagent_type="general-purpose"
)
```

通用型 Sub-Agent 会利用 `web_search` 等工具搜索论文信息，在自己的隔离上下文中完成分析，最后将结果返回给 Lead Agent。

## 11.6 thinking 引导与 critical_reminders

除了 `<subagent_system>` 块，System Prompt 还在 `<thinking_style>` 和 `<critical_reminders>` 中嵌入了编排相关的引导：

```python
subagent_thinking = (
    "- **DECOMPOSITION CHECK: Can this task be broken into 2+ "
    "parallel sub-tasks? If YES, COUNT them. "
    f"If count > {n}, you MUST plan batches of <={n} and only "
    f"launch the FIRST batch now. "
    f"NEVER launch more than {n} `task` calls in one response.**\n"
)

subagent_reminder = (
    "- **Orchestrator Mode**: You are a task orchestrator - "
    "decompose complex tasks into parallel sub-tasks. "
    f"**HARD LIMIT: max {n} `task` calls per response.** "
    f"If >{n} sub-tasks, split into sequential batches of <={n}. "
    "Synthesize after ALL batches complete.\n"
)
```

这种"多处重复、不同视角"的提示策略是实践中被证明有效的方式——在思考阶段提醒分解检查，在执行阶段提醒硬限制，在总结提醒中强调综合。多层强化显著降低了模型违反规则的概率。

## 11.7 从 Prompt 到 Middleware 的完整链路

总结整个并发调度的工作流程：

1. **Prompt 引导**：System Prompt 告诉模型"你是编排者，最多 N 个并行"
2. **模型生成**：LLM 在 thinking 中计划批次，生成 tool_calls
3. **Middleware 截断**：`SubagentLimitMiddleware.after_model` 检查并截断多余调用
4. **任务提交**：每个 `task` 调用触发 `task_tool`，创建 `SubagentExecutor`
5. **异步执行**：`execute_async` 提交到 scheduler 池，再到 execution 池
6. **轮询等待**：`task_tool` 每 5 秒轮询，推送进度到前端
7. **结果返回**：Sub-Agent 完成后，结果返回 Lead Agent
8. **下一批次**：如果还有剩余子任务，模型继续发起下一批
9. **综合输出**：所有批次完成后，Lead Agent 综合结果

这条链路中，Prompt 工程和 Middleware 形成了"指导 + 保障"的双重机制。即使 LLM 偶尔"忘记"并发限制，Middleware 也能兜底。

## 小结

DeerFlow 的并发调度策略体现了对 LLM 特性的深刻理解：

- `SubagentLimitMiddleware` 在 `after_model` 阶段截断多余的 `task` 调用，提供硬性保障
- 限制值被钳位到 [2, 4] 范围，防御性地避免资源耗尽
- System Prompt 通过"分解-委派-综合"三步法和多批次策略引导 LLM 正确编排
- 多处重复的并发限制提示（thinking / subagent_system / critical_reminders）降低模型违规概率
- `max_concurrent` 参数在 Prompt 和 Middleware 间保持一致，确保软硬约束对齐
- 实际工作负载通过多批次模式适配并发限制，兼顾吞吐量和系统稳定性

至此，我们已经完整理解了 DeerFlow 从任务分解到并行执行再到结果综合的全流程。这套"Prompt 引导 + Middleware 兜底 + 线程池执行"的三层架构，在工程实践中展现了很好的可靠性和扩展性。
