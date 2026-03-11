# 第 1 章　DeerFlow 是什么，为什么重要

## 1.1　从名字说起

DeerFlow 的全称是 **Deep Exploration and Efficient Research Flow**，由字节跳动开源，是一个 **Super Agent Harness**——给 AI 智能体提供"运行时基础设施"的开源平台。它编排子智能体（sub-agents）、记忆（memory）、沙箱（sandbox），通过可扩展的技能（skills）让 Agent 几乎能做任何事。

2026 年 2 月 28 日，DeerFlow 2.0 发布当天登顶 GitHub Trending 第一名。

## 1.2　Harness vs Framework：本质区别

很多人把 DeerFlow 和 LangChain、LlamaIndex 这类 **Framework** 相提并论，但两者的设计哲学完全不同。

| 维度 | Framework（框架） | Harness（运行时平台） |
|------|-------------------|----------------------|
| 设计理念 | 提供积木，自己搭 | Batteries included，开箱即用 |
| 执行环境 | 你自己搞定 | 自带沙箱、文件系统、进程隔离 |
| 决策权 | 开发者写流程 | Agent 自主规划、拆解、执行 |
| 扩展方式 | 插件/中间件 | Skills + MCP Server + 子智能体 |
| Opinionated 程度 | 低（灵活但需要大量胶水代码） | 高（约定优于配置，但可替换） |

DeerFlow 是 **opinionated** 的：它预设了 Lead Agent 编排子智能体的模式、预设了沙箱执行环境、预设了 Skills 的加载方式。你可以改，但不改也能直接跑。这就是 "batteries included" 的含义。

## 1.3　Long-horizon Agent 的三个特征

DeerFlow 瞄准的是 **Long-horizon Agent**——那些运行时间从分钟到小时、需要自主决策、最终产出"初稿"级别交付物的任务。

**特征一：运行时间长。** 不是一问一答的聊天，而是持续执行分钟到小时的复杂任务。比如让 DeerFlow 做一份完整的市场调研报告，它会启动多个子智能体并行搜索、分析、汇总，整个过程可能花费 10-30 分钟。

**特征二：自主决策。** DeerFlow 的 Lead Agent 不是按预设流程跑的状态机，而是根据任务动态拆解、动态分配子智能体。看下面的系统提示词模板就能感受到这种"自主性"：

```python
# 摘自 backend/src/agents/lead_agent/prompt.py

SYSTEM_PROMPT_TEMPLATE = """
<role>
You are {agent_name}, an open-source super agent.
</role>

{soul}
{memory_context}

<thinking_style>
- Think concisely and strategically about the user's request BEFORE taking action
- Break down the task: What is clear? What is ambiguous? What is missing?
- **PRIORITY CHECK: If anything is unclear, missing, or has multiple interpretations,
  you MUST ask for clarification FIRST - do NOT proceed with work**
{subagent_thinking}- Never write down your full final answer or report in thinking process,
  but only outline
</thinking_style>

...

<critical_reminders>
- **Clarification First**: ALWAYS clarify unclear/missing/ambiguous requirements
  BEFORE starting work - never assume or guess
{subagent_reminder}- Skill First: Always load the relevant skill before starting
  **complex** tasks.
- Progressive Loading: Load resources incrementally as referenced in skills
- Output Files: Final deliverables must be in `/mnt/user-data/outputs`
</critical_reminders>
"""
```

这段提示词体现了 DeerFlow 的核心理念：先想清楚、先澄清、再行动，技能按需加载，最终交付物放到指定目录。Agent 自己决定怎么拆解任务、调用哪些工具、是否需要子智能体。

**特征三：产出"初稿"。** DeerFlow 的目标不是给你一个完美答案，而是产出一份可以在此基础上修改的初稿——一份报告、一个网站、一组幻灯片、一段分析代码。

正如 LangChain 创始人 Harrison Chase 所言：Long-horizon Agent 之所以现在开始真正 work 了，是因为三件事同时成熟了——**模型推理能力**（reasoning 足够强）、**工具生态**（MCP 等标准让 Agent 能调用几乎任何服务）、**上下文工程**（context engineering 让 Agent 在长任务中不会"忘事"）。DeerFlow 正是在这三个条件成熟的窗口期诞生的。

## 1.4　从 v1 到 v2：一次从头重写

DeerFlow v1 诞生于 2025 年 5 月，定位是 **Deep Research 框架**。它做的事情很简单：接收一个研究问题，自动搜索、分析、生成研究报告。

然后社区做了 DeerFlow 团队没有预料到的事情：

- 有人用它做 **数据分析**，把 CSV 丢进去让 Agent 自动建模
- 有人用它做 **PPT 生成**，一句话生成完整的演示文稿
- 有人搭了 **内容工厂**，批量生成产品文案和 SEO 文章
- 有人用它做 **运维巡检**，每天自动检查服务器状态并生成报告

这些用例让团队意识到：Deep Research 只是 DeerFlow 能做的第一个 Skill。DeerFlow 的本质是一个 **Harness**——一个给 Agent 提供运行时基础设施的平台。

于是在 2026 年春节期间，团队做了一个大胆的决定：**从头重写**。DeerFlow 2.0 与 v1 不共享任何代码。v1 被维护在 `1.x` 分支上，活跃开发全部转到 2.0。

## 1.5　实际用例

**用例一：市场调研报告。** 告诉 DeerFlow "帮我调研 2026 年中国新能源汽车出海市场"，它会启动多个子智能体分别搜索政策法规、竞品分析、市场数据，最终合并成一份带引用的完整报告。

**用例二：代码库分析。** 把一个 GitHub 仓库地址丢给 DeerFlow，它会 clone 下来、分析架构、阅读关键文件，生成一份技术架构文档。

**用例三：生成美妆品牌网站（CAREN 案例）。** 这是社区中的经典案例——用户只说了 "帮我做一个叫 CAREN 的美妆品牌网站"，DeerFlow 自动设计页面结构、生成 HTML/CSS、搜索参考图片、输出完整的静态网站。

这些用例的共同特点是：不是一个 API 调用能搞定的，需要 Agent 持续工作、自主决策、最终产出一个完整的交付物。

## 1.6　与其他产品的定位对比

| 产品 | 定位 | 交互方式 | 开源 |
|------|------|---------|------|
| **DeerFlow** | Super Agent Harness | 任务驱动，产出文件/网站/报告 | 是（MIT） |
| OpenAI Operator | 浏览器自动化 Agent | 操控浏览器完成任务 | 否 |
| Manus | 通用 AI Agent | 云端运行，操控虚拟桌面 | 否 |
| Claude Computer Use | 计算机控制能力 | 操控鼠标键盘 | API（非产品） |

DeerFlow 的核心差异在于：它是**开源的**、**可自托管的**、**面向开发者的**。你可以在自己的服务器上运行它，用自己选择的模型，扩展自己的 Skills。它不是一个封闭的产品，而是一个你可以拆开来改的平台。

## 小结

- **DeerFlow 是一个 Super Agent Harness**，不是框架——它提供开箱即用的 Agent 运行时环境，包括沙箱、记忆、技能系统和子智能体编排。
- **Long-horizon Agent 的三个特征**：运行时间长（分钟到小时）、自主决策（不是预设流程）、产出"初稿"级别的交付物。
- **v1 到 v2 是一次从头重写**：社区的多样化用例证明 Deep Research 只是第一个 Skill，DeerFlow 的本质是通用 Agent 平台。
- **开源 + 可自托管** 是 DeerFlow 区别于 Operator/Manus 等封闭产品的核心优势。
- **系统提示词的设计** 体现了 DeerFlow 的核心理念：先澄清、再规划、按需加载技能、自主拆解任务。
