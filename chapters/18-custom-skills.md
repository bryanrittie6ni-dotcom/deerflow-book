# 第 18 章　编写自定义 Skill

上一章我们深入了解了 DeerFlow 的 Skills 系统架构。本章将从实践出发，手把手教你编写自己的 Skill——将团队的专属工作流封装为可复用的能力单元。

## 18.1 SKILL.md 完整格式规范

每个 Skill 的核心是一个 `SKILL.md` 文件，它由两部分组成：YAML frontmatter 和 Markdown 正文。

### YAML Frontmatter

```yaml
---
name: my-skill-name
description: 这里是 Skill 的触发描述，Agent 根据它决定是否加载本 Skill
license: MIT
---
```

必填字段只有两个：

| 字段 | 是否必填 | 说明 |
|------|---------|------|
| `name` | 是 | Skill 的唯一标识符，建议使用 kebab-case |
| `description` | 是 | 触发描述——Agent 在系统提示词中看到的唯一信息 |
| `license` | 否 | 许可证声明 |

回顾解析器的判断逻辑（来自 `parser.py`）：

```python
name = metadata.get("name")
description = metadata.get("description")

if not name or not description:
    return None  # 缺少必填字段，跳过此 Skill
```

缺少 `name` 或 `description` 的 SKILL.md 会被静默跳过，不会报错，但也不会被加载。

### description 字段的编写策略

`description` 是整个 Skill 最关键的字段。它不是普通的功能描述，而是 **Agent 的触发条件**。在运行时，Agent 的系统提示词中只包含所有启用 Skill 的 name + description + 文件路径，Agent 根据这些简短描述决定是否调用 `read_file` 加载完整指令。

以 `deep-research` 为例，它的 description 采用了"推动式"写法：

> Use this skill instead of WebSearch for ANY question requiring web research. Trigger on queries like "what is X", "explain X", "compare X and Y", "research X", or before content generation tasks.

这里有几个值得学习的技巧：

1. **明确替代关系**："instead of WebSearch" 告诉 Agent 应该优先使用本 Skill
2. **列举触发短语**："what is X", "explain X" 等具体示例降低了误判概率
3. **扩大触发范围**："before content generation tasks" 覆盖了间接场景
4. **语气偏"推动"**：宁可多触发一些，也不要漏掉应该触发的场景

根据 `skill-creator` Skill 中的指导：

> Currently Claude has a tendency to "undertrigger" skills -- to not use them when they'd be useful. To combat this, please make the skill descriptions a little bit "pushy".

### Markdown 正文

Frontmatter 之后的 Markdown 正文是 Skill 的完整操作手册。当 Agent 决定加载某个 Skill 时，它会读取这部分内容并严格遵循执行。正文通常包含：

- **概述**：Skill 的核心能力和适用场景
- **工作流程**：分步骤的操作指南
- **参数说明**：脚本调用的参数格式
- **示例**：具体的使用案例
- **注意事项**：边界条件和常见错误

## 18.2 Skill 的数据模型回顾

在编写自定义 Skill 之前，再来看一下系统如何表示一个 Skill（来自 `types.py`）：

```python
@dataclass
class Skill:
    name: str              # 从 YAML frontmatter 解析
    description: str       # 从 YAML frontmatter 解析
    license: str | None    # 可选的许可证
    skill_dir: Path        # Skill 所在目录
    skill_file: Path       # SKILL.md 的完整路径
    relative_path: Path    # 从分类根目录的相对路径
    category: str          # 'public' 或 'custom'
    enabled: bool = False  # 运行时启用状态
```

`category` 字段很重要——加载器通过它区分内置和自定义 Skill。当你把 Skill 放在 `skills/custom/` 目录下时，`category` 自动设为 `"custom"`，默认启用。

## 18.3 自定义 Skill 的目录结构设计

一个功能完整的自定义 Skill 推荐使用如下结构：

```
skills/custom/
└── competitor-analysis/
    ├── SKILL.md              # 必须：元数据 + 操作指令
    ├── scripts/              # 可选：可执行脚本
    │   └── generate_report.py
    ├── references/           # 可选：参考文档（按需读取）
    │   ├── frameworks.md
    │   └── metrics-guide.md
    └── assets/               # 可选：模板和静态资源
        └── report-template.html
```

`skill-creator` Skill 中对此有明确的设计指导：

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - 可执行代码，用于确定性/重复性任务
    ├── references/ - 按需加载到上下文的文档
    └── assets/     - 输出时使用的文件（模板、图标、字体）
```

核心原则是：`SKILL.md` 本身控制在 500 行以内，如果内容太多就分层——将详细的操作指南拆到 `references/` 目录中，在 SKILL.md 里用明确的指引告诉 Agent 何时去读取哪个文件。

## 18.4 实战：从零写一个"竞品分析"Skill

让我们通过一个完整的示例，创建一个帮助团队做竞品分析的 Skill。

### 第一步：创建目录

```bash
mkdir -p skills/custom/competitor-analysis/references
```

### 第二步：编写 SKILL.md

```markdown
---
name: competitor-analysis
description: 对目标公司或产品进行系统化竞品分析。当用户提到"竞品分析"、
  "竞争对手"、"市场对比"、"和 XX 比怎么样"、"XX 的替代品"，或者需要在
  制定产品策略前了解竞争格局时，使用此 Skill。即使用户没有明确说"竞品分析"，
  只要涉及到产品对比或市场定位，也应主动加载此 Skill。
---

# 竞品分析 Skill

## 概述

本 Skill 提供一套结构化的竞品分析方法论，帮助你从多个维度对比分析
目标产品与其竞争对手，产出可供决策参考的分析报告。

## 分析流程

### Phase 1：确定分析范围

在开始之前，明确以下信息：

1. **目标产品**：要分析的核心产品是什么
2. **竞品列表**：直接竞品（同品类）和间接竞品（替代方案）各 2-3 个
3. **分析维度**：根据需求从以下维度中选择
   - 产品功能对比
   - 定价策略
   - 目标用户群
   - 市场份额与增长趋势
   - 技术架构（如适用）
   - 用户口碑与评价

如果用户未指定竞品，先通过网络搜索识别主要竞争对手。

### Phase 2：多维度信息收集

针对每个竞品，按以下模式搜集信息：

```
搜索模式：
- "[产品名] vs [竞品名] comparison 2026"
- "[竞品名] pricing plans"
- "[竞品名] user reviews site:g2.com OR site:trustpilot.com"
- "[竞品名] market share [行业]"
- "[竞品名] technical architecture"
```

对每个重要来源使用 web_fetch 获取完整内容，不要只依赖搜索摘要。

### Phase 3：结构化分析

将收集的信息整理为对比矩阵：

| 维度 | 目标产品 | 竞品 A | 竞品 B | 竞品 C |
|------|---------|--------|--------|--------|
| 核心功能 | ... | ... | ... | ... |
| 定价 | ... | ... | ... | ... |
| 目标用户 | ... | ... | ... | ... |

### Phase 4：输出报告

按照以下模板生成最终报告：

# [目标产品] 竞品分析报告

## 执行摘要
（200 字以内的核心结论）

## 竞争格局概览
（市场定位图谱，使用 Mermaid 图表）

## 逐项对比分析
（每个维度的详细分析）

## SWOT 总结
（目标产品的优势、劣势、机会、威胁）

## 战略建议
（基于分析的 3-5 条可执行建议）

## 详细参考框架

如需更深入的分析框架，请阅读参考文档：
- 框架选择指南：`references/frameworks.md`
- 量化指标说明：`references/metrics-guide.md`
```

### 第三步：添加参考文档

创建 `references/frameworks.md`，提供更详细的分析框架说明（如波特五力、PEST 分析等），Agent 只在需要深度分析时才读取此文件。

### 第四步：验证加载

将 Skill 放入 `skills/custom/` 目录后，DeerFlow 会在下次加载时自动发现它。由于 `ExtensionsConfig.is_skill_enabled` 对 `custom` 类别默认返回 `True`，无需额外配置即可启用。

## 18.5 把团队工作流封装成 Skill

将日常工作流封装为 Skill 的通用思路：

1. **观察重复模式**：团队中哪些任务经常重复？哪些流程有固定的步骤？
2. **提炼核心步骤**：将工作流拆解为清晰的阶段（Phase），每个阶段有明确的输入输出
3. **识别工具需求**：流程中需要用到哪些工具？网络搜索、文件读写、脚本执行？
4. **编写操作指令**：用 Markdown 写出足够具体的指令，让 Agent "看了就能做"
5. **提取可复用脚本**：如果多个步骤涉及相同的数据处理逻辑，将其封装为 `scripts/` 中的脚本
6. **迭代优化**：运行几次测试用例，根据 Agent 的实际表现调整指令措辞

`skill-creator` Skill 提供了完整的创建和评估流程，包括自动化的触发测试和描述优化。如果你需要创建高质量的 Skill，可以直接让 DeerFlow 加载 `skill-creator` 来辅助完成。

## 18.6 Skill 与 MCP 的区别

在 DeerFlow 的扩展体系中，Skill 和 MCP（Model Context Protocol）server 是两个截然不同的概念，但初学者容易混淆。

| 对比维度 | Skill | MCP Server |
|---------|-------|------------|
| **本质** | 行为模式——告诉 Agent "怎么做" | 工具连接器——告诉 Agent "能用什么" |
| **形式** | Markdown 文件 + 可选脚本 | 运行中的服务进程 |
| **作用** | 提供工作流、方法论、操作手册 | 暴露具体的可调用工具（函数） |
| **示例** | deep-research 提供多角度研究方法论 | 搜索引擎 MCP 提供 `web_search` 函数 |
| **加载方式** | 读取文件内容到上下文 | 启动进程，注册工具到 Agent |
| **配置位置** | `skills/` 目录 | `extensions_config.json` 的 `mcpServers` |

一个直观的类比：MCP server 相当于给 Agent 一把锤子（工具），而 Skill 相当于给 Agent 一本木工手册（知识和方法）。最强大的组合是——用 Skill 定义"做什么以及怎么做"，用 MCP 提供"需要的工具"。

例如，`data-analysis` Skill 的 SKILL.md 定义了数据分析的完整工作流（检查结构 -> SQL 查询 -> 统计汇总 -> 导出结果），而它依赖的 DuckDB 分析脚本 `scripts/analyze.py` 是实际执行计算的工具。Skill 编排了流程，脚本提供了能力。

## 18.7 高级技巧

### 利用渐进式加载控制上下文

当 Skill 内容复杂时，不要把所有信息塞进 SKILL.md。按照三层加载模型：

```
competitor-analysis/
├── SKILL.md              # < 500 行，核心流程
└── references/
    ├── frameworks.md     # 分析框架详解（按需读取）
    ├── aws.md            # 特定领域参考
    └── gcp.md
```

在 SKILL.md 中用明确的指引告诉 Agent 何时读取哪个文件：

```markdown
## 分析框架选择
如果用户要求使用特定分析框架（波特五力、PEST等），
请先阅读 `references/frameworks.md` 了解各框架的适用场景。
```

### 脚本封装确定性逻辑

如果 Skill 涉及需要精确执行的逻辑（数据处理、文件格式转换、API 调用），将其封装为脚本而非自然语言指令。脚本的执行结果是确定性的，而让 Agent "手写代码" 每次都可能不同。

### 测试与迭代

使用 `skill-creator` 的评估流程：

1. 编写 2-3 个测试用例
2. 让 Agent 带着 Skill 执行这些用例
3. 对比有 Skill 和无 Skill 时的输出质量
4. 根据反馈调整 SKILL.md 的措辞
5. 重复直到满意

## 小结

1. **SKILL.md 是一切的核心**：YAML frontmatter 声明元数据（name + description 必填），Markdown 正文是 Agent 的操作手册。解析器采用零依赖的简单字符串分割实现，保持轻量。

2. **description 决定触发率**：这是 Agent 选择是否加载 Skill 的唯一依据。应采用"推动式"写法，列举触发短语，覆盖直接和间接场景，宁可多触发也不要漏触发。

3. **目录结构是约定而非限制**：`SKILL.md` 必须存在，`scripts/`、`references/`、`assets/` 是推荐约定。利用渐进式加载将大量内容拆分到外部文件，保持主文件精简。

4. **Skill 是行为模式，MCP 是工具连接器**：Skill 定义"怎么做"，MCP 提供"能用什么"。两者配合使用才能发挥最大威力。

5. **从团队工作流出发**：最好的自定义 Skill 来源于日常重复性工作的提炼和封装。观察模式、提炼步骤、编写指令、迭代优化，这是一个持续改进的过程。
