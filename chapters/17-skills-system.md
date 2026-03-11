# 第 17 章　Skills 系统：能力的核心扩展单元

在前面的章节中，我们了解了 DeerFlow 的整体架构和 Agent 调度机制。但一个关键问题始终存在：Agent 的能力从哪里来？答案就是 **Skills 系统**——DeerFlow 最核心的可扩展能力单元。

## 17.1 Skill 是什么

在 DeerFlow 中，一个 Skill 就是 **一个目录加上一个 `SKILL.md` 文件**。`SKILL.md` 采用 YAML frontmatter + Markdown 正文的格式，既是元数据声明，也是 Agent 执行任务时的完整操作手册。

一个典型的 Skill 目录结构如下：

```
skills/
├── public/          # 内置 Skill
│   ├── deep-research/
│   │   └── SKILL.md
│   ├── data-analysis/
│   │   ├── SKILL.md
│   │   └── scripts/
│   │       └── analyze.py
│   ├── image-generation/
│   │   ├── SKILL.md
│   │   ├── scripts/
│   │   └── templates/
│   └── ...
└── custom/          # 用户自定义 Skill
    └── my-skill/
        └── SKILL.md
```

在容器运行环境中，这些目录被挂载到 `/mnt/skills/public/` 和 `/mnt/skills/custom/`，Agent 通过读取对应路径下的 `SKILL.md` 获取完整的操作指令。

## 17.2 Skill 的数据模型

Skill 的核心数据结构定义在 `backend/src/skills/types.py` 中：

```python
@dataclass
class Skill:
    """Represents a skill with its metadata and file path"""

    name: str
    description: str
    license: str | None
    skill_dir: Path
    skill_file: Path
    relative_path: Path      # 从分类根目录到 Skill 目录的相对路径
    category: str             # 'public' 或 'custom'
    enabled: bool = False     # 是否启用

    @property
    def skill_path(self) -> str:
        """返回从分类根目录到 Skill 目录的相对路径"""
        path = self.relative_path.as_posix()
        return "" if path == "." else path

    def get_container_path(self, container_base_path: str = "/mnt/skills") -> str:
        category_base = f"{container_base_path}/{self.category}"
        skill_path = self.skill_path
        if skill_path:
            return f"{category_base}/{skill_path}"
        return category_base
```

注意 `get_container_path` 方法：它将本地开发路径映射为容器内路径，这样无论在开发环境还是生产容器中，Skill 的引用路径都是一致的。

## 17.3 SKILL.md 的解析过程

`backend/src/skills/parser.py` 负责从文件解析出 `Skill` 对象。它的核心逻辑是通过正则表达式提取 YAML frontmatter：

```python
def parse_skill_file(skill_file: Path, category: str,
                     relative_path: Path | None = None) -> Skill | None:
    content = skill_file.read_text(encoding="utf-8")

    # 提取 YAML front matter：--- 之间的内容
    front_matter_match = re.match(
        r"^---\s*\n(.*?)\n---\s*\n", content, re.DOTALL
    )
    if not front_matter_match:
        return None

    front_matter = front_matter_match.group(1)

    # 简单的 key-value 解析
    metadata = {}
    for line in front_matter.split("\n"):
        line = line.strip()
        if not line:
            continue
        if ":" in line:
            key, value = line.split(":", 1)
            metadata[key.strip()] = value.strip()

    name = metadata.get("name")
    description = metadata.get("description")

    if not name or not description:
        return None

    return Skill(
        name=name, description=description,
        license=metadata.get("license"),
        skill_dir=skill_file.parent,
        skill_file=skill_file,
        relative_path=relative_path or Path(skill_file.parent.name),
        category=category,
        enabled=True,
    )
```

设计上值得关注的几点：解析器没有引入 PyYAML 等外部依赖，而是用简单的字符串分割实现，这让整个 Skills 系统保持了零外部依赖的轻量特性。`name` 和 `description` 是必填字段，缺少任何一个都会导致解析返回 `None`，从而跳过该 Skill。

## 17.4 Skill 的加载与发现

`backend/src/skills/loader.py` 中的 `load_skills` 函数负责遍历目录并收集所有 Skill：

```python
def load_skills(skills_path: Path | None = None,
                use_config: bool = True,
                enabled_only: bool = False) -> list[Skill]:
    skills = []

    # 依次扫描 public 和 custom 两个分类目录
    for category in ["public", "custom"]:
        category_path = skills_path / category
        if not category_path.exists() or not category_path.is_dir():
            continue

        for current_root, dir_names, file_names in os.walk(category_path):
            # 排序并跳过隐藏目录
            dir_names[:] = sorted(
                name for name in dir_names if not name.startswith(".")
            )
            if "SKILL.md" not in file_names:
                continue

            skill_file = Path(current_root) / "SKILL.md"
            relative_path = skill_file.parent.relative_to(category_path)
            skill = parse_skill_file(skill_file, category=category,
                                     relative_path=relative_path)
            if skill:
                skills.append(skill)

    # 从 ExtensionsConfig 加载启用/禁用状态
    extensions_config = ExtensionsConfig.from_file()
    for skill in skills:
        skill.enabled = extensions_config.is_skill_enabled(
            skill.name, skill.category
        )

    if enabled_only:
        skills = [skill for skill in skills if skill.enabled]

    skills.sort(key=lambda s: s.name)
    return skills
```

加载流程有几个精心设计的细节：

1. **双目录扫描**：先 `public` 后 `custom`，覆盖内置和用户自定义两类 Skill。
2. **递归遍历**：使用 `os.walk` 支持嵌套目录结构，Skill 可以组织在子目录中。
3. **运行时状态**：通过 `ExtensionsConfig.from_file()` 每次都从磁盘读取最新配置，确保 Gateway API 的修改能实时生效。
4. **确定性排序**：按名称排序，保证加载顺序一致。

## 17.5 运行时启用与禁用：extensions_config.json

DeerFlow 通过 `extensions_config.json` 控制 Skill 的运行时状态：

```json
{
  "skills": {
    "deep-research": { "enabled": true },
    "video-generation": { "enabled": false }
  }
}
```

对应的判断逻辑在 `ExtensionsConfig.is_skill_enabled` 中：

```python
def is_skill_enabled(self, skill_name: str, skill_category: str) -> bool:
    skill_config = self.skills.get(skill_name)
    if skill_config is None:
        # 未明确配置时，public 和 custom 类别默认启用
        return skill_category in ("public", "custom")
    return skill_config.enabled
```

这意味着你不需要在配置文件中列出所有 Skill——只需要配置那些需要禁用的即可，默认策略是 "全部启用"。

## 17.6 渐进式加载：保持 Context 精简

DeerFlow 的 Skills 系统采用 **三层渐进式加载** 策略，这是其设计中最精妙的部分：

| 层级 | 内容 | 何时加载 | 大小 |
|------|------|---------|------|
| 第一层 | name + description | 始终在 Agent 上下文中 | 约 100 词 |
| 第二层 | SKILL.md 正文 | 用户查询匹配到 Skill 时 | 建议 < 500 行 |
| 第三层 | 脚本、参考文档、模板 | 执行过程中按需读取 | 无限制 |

在 `prompt.py` 的 `get_skills_prompt_section` 函数中，只有第一层元数据被注入到系统提示词：

```python
def get_skills_prompt_section(available_skills=None) -> str:
    skills = load_skills(enabled_only=True)
    # ...
    skill_items = "\n".join(
        f"    <skill>\n"
        f"        <name>{skill.name}</name>\n"
        f"        <description>{skill.description}</description>\n"
        f"        <location>{skill.get_container_file_path(...)}</location>\n"
        f"    </skill>"
        for skill in skills
    )
```

Agent 收到的系统提示词中包含这段指令：

```
**Progressive Loading Pattern:**
1. 当用户查询匹配某个 Skill 时，立即调用 read_file 读取 Skill 主文件
2. 阅读并理解 Skill 的工作流和指令
3. Skill 文件中引用了同目录下的外部资源
4. 仅在执行过程中需要时才加载引用的资源
5. 严格遵循 Skill 的指令执行
```

这意味着 17 个内置 Skill 不会把数千行的操作手册全部塞进上下文窗口，而是只暴露简短的描述信息，让 Agent 根据任务需求"按需加载"，极大地节省了 token 消耗。

## 17.7 内置 Skill 全览

DeerFlow 目前提供以下内置 Skill：

| Skill 名称 | 用途说明 |
|------------|---------|
| `deep-research` | 系统化多角度网络研究，替代简单的单次搜索 |
| `data-analysis` | 基于 DuckDB 的 Excel/CSV 数据分析，支持 SQL 查询和统计汇总 |
| `chart-visualization` | 从 26 种图表类型中智能选择，生成数据可视化图表 |
| `frontend-design` | 生成高质量前端界面代码，避免"AI 风格"的通用设计 |
| `web-design-guidelines` | 基于 Vercel Web Interface Guidelines 审查 UI 代码 |
| `image-generation` | 图像生成，支持结构化提示词和参考图 |
| `video-generation` | 视频生成，支持结构化提示词和参考图 |
| `podcast-generation` | 将文本内容转化为双主持人对话式播客音频 |
| `ppt-generation` | 为每页幻灯片生成图片并组装为 PowerPoint 文件 |
| `github-deep-research` | 对 GitHub 仓库进行多轮深度分析和时间线重建 |
| `consulting-analysis` | 生成咨询级别的专业分析报告 |
| `skill-creator` | 创建、修改和评估 Skill 的元技能 |
| `bootstrap` | 通过对话生成个性化的 SOUL.md（Agent 人格文件） |
| `find-skills` | 帮助用户发现和安装可用的 Skill |
| `surprise-me` | 创造性地组合其他 Skill 产生"惊喜"体验 |
| `claude-to-deerflow` | 通过 HTTP API 与 DeerFlow 平台交互 |
| `vercel-deploy` | 将应用部署到 Vercel，返回预览 URL |

## 17.8 一个真实的 SKILL.md 示例

以 `deep-research` 为例，看看一个完整的 SKILL.md 长什么样：

```markdown
---
name: deep-research
description: Use this skill instead of WebSearch for ANY question requiring
  web research. Trigger on queries like "what is X", "explain X",
  "compare X and Y", "research X", or before content generation tasks.
  Provides systematic multi-angle research methodology instead of single
  superficial searches.
---

# Deep Research Skill

## Overview
This skill provides a systematic methodology for conducting thorough
web research.

## Research Methodology

### Phase 1: Broad Exploration
Start with broad searches to understand the landscape...

### Phase 2: Deep Dive
For each important dimension identified, conduct targeted research...

### Phase 3: Diversity & Validation
Ensure comprehensive coverage by seeking diverse information types...

### Phase 4: Synthesis Check
Before proceeding to content generation, verify:
- [ ] Have I searched from at least 3-5 different angles?
- [ ] Have I fetched and read the most important sources in full?
...
```

注意 `description` 字段的措辞策略——它不是简单地描述功能，而是明确告诉 Agent **何时应该触发** 这个 Skill（"Use this skill instead of WebSearch for ANY question..."）。这种 "推动式" 的描述是 DeerFlow Skill 设计的一个重要技巧，能有效防止 Agent "欠触发" 的问题。

## 17.9 Skill 可以包含的资源类型

Skill 目录中除了必须的 `SKILL.md`，还可以包含多种辅助资源：

- **脚本文件**（`scripts/`）：Python、Node.js、Shell 脚本，用于执行确定性的、可重复的任务。例如 `data-analysis` 的 DuckDB 分析脚本、`chart-visualization` 的图表生成脚本。
- **参考文档**（`references/`）：额外的指导文档，按需读取。例如一个支持多云部署的 Skill 可以将 AWS、GCP、Azure 的参考文档分开存放。
- **模板文件**（`assets/`）：图片模板、字体、HTML 模板等静态资源。
- **配置文件**：评估用例、触发测试集等。

关键原则是：`SKILL.md` 本身控制在 500 行以内，大量内容通过引用外部资源实现，Agent 只在需要时才读取对应文件。

## 小结

1. **Skill = 目录 + SKILL.md**：一个 Skill 的本质是一个包含 YAML frontmatter 和 Markdown 指令的文件，加上可选的脚本、模板和参考文档。解析器零外部依赖，设计极度轻量。

2. **三层渐进式加载**：元数据（始终可见）-> SKILL.md 正文（按需加载）-> 外部资源（执行时读取），这种分层策略让 17 个内置 Skill 不会撑爆上下文窗口。

3. **运行时可控**：通过 `extensions_config.json` 实现 Skill 的动态启用和禁用，默认策略是全部启用，只需配置需要关闭的项目。

4. **description 即触发器**：Skill 的 `description` 字段是 Agent 决定是否加载该 Skill 的唯一依据，精心编写的描述直接影响触发准确率。

5. **双目录体系**：`public/`（内置）和 `custom/`（用户自定义）分离，内置 Skill 随版本更新，自定义 Skill 独立维护，互不干扰。
