# 第 11 章　长期记忆架构

绝大多数 Agent 框架的会话在结束后即刻失忆——下一次对话从零开始，用户不得不反复自我介绍、重复偏好设定。DeerFlow 的做法截然不同：它在后台维护一套持久化的记忆系统，使 Agent 能够跨会话地"认识"用户、积累上下文、追踪目标。

本章将深入剖析这套记忆架构的数据模型、配置体系和缓存策略。

## 11.1 记忆的三层结构

打开 `updater.py` 中的 `_create_empty_memory()` 函数，可以看到记忆的骨架：

```python
def _create_empty_memory() -> dict[str, Any]:
    return {
        "version": "1.0",
        "lastUpdated": datetime.utcnow().isoformat() + "Z",
        "user": {
            "workContext": {"summary": "", "updatedAt": ""},
            "personalContext": {"summary": "", "updatedAt": ""},
            "topOfMind": {"summary": "", "updatedAt": ""},
        },
        "history": {
            "recentMonths": {"summary": "", "updatedAt": ""},
            "earlierContext": {"summary": "", "updatedAt": ""},
            "longTermBackground": {"summary": "", "updatedAt": ""},
        },
        "facts": [],
    }
```

这三层结构各有分工：

**第一层：用户画像（user）** 捕捉用户"是谁"。

- `workContext`：职业角色、公司、关键项目、主力技术栈（2-3 句话）。
- `personalContext`：语言能力、沟通偏好、兴趣领域（1-2 句话）。
- `topOfMind`：当前关注的多个并行焦点（3-5 句话），更新频率最高。

**第二层：时间线（history）** 记录用户"做过什么"。

- `recentMonths`：近 1-3 个月的详细活动摘要（4-6 句话）。
- `earlierContext`：3-12 个月前的重要模式（3-5 句话）。
- `longTermBackground`：长期不变的基础背景（2-4 句话）。

**第三层：事实库（facts）** 存储离散、可检索的结构化知识点。

## 11.2 Facts 的五种类别

每条 fact 都携带 `category` 字段，取值来自五种类别：

| 类别 | 含义 | 示例 |
|------|------|------|
| `preference` | 用户偏好 | "偏好使用 Vim 而非 VS Code" |
| `knowledge` | 专业知识 | "精通 Rust 和 WebAssembly" |
| `context` | 背景事实 | "在字节跳动担任高级工程师" |
| `behavior` | 行为模式 | "习惯先写测试再写实现" |
| `goal` | 目标意图 | "计划在 Q2 发布 v2.0" |

在 `_apply_updates` 方法中，每条新 fact 被构造为完整的结构化条目：

```python
fact_entry = {
    "id": f"fact_{uuid.uuid4().hex[:8]}",
    "content": fact.get("content", ""),
    "category": fact.get("category", "context"),
    "confidence": confidence,
    "createdAt": now,
    "source": thread_id or "unknown",
}
current_memory["facts"].append(fact_entry)
```

## 11.3 Confidence 阈值：0.7 的门槛

并非所有 LLM 抽取的 fact 都会被保留。`MemoryConfig` 中定义了置信度阈值：

```python
class MemoryConfig(BaseModel):
    fact_confidence_threshold: float = Field(
        default=0.7,
        ge=0.0,
        le=1.0,
        description="Minimum confidence threshold for storing facts",
    )
```

在 `_apply_updates` 中，只有达到阈值的 fact 才会入库：

```python
confidence = fact.get("confidence", 0.5)
if confidence >= config.fact_confidence_threshold:
    # 入库
```

Prompt 中对置信度给出了清晰的分级指引：

- **0.9-1.0**：用户明确陈述的事实（"我在做 X 项目"）
- **0.7-0.8**：从行为中强烈推断的信息
- **0.5-0.6**：推测性模式（慎用，仅对清晰模式使用）

默认阈值 0.7 意味着只有"明确陈述"和"强烈推断"的信息才会进入记忆。这个设计在信息保留和噪声过滤之间取得了平衡。

## 11.4 全局记忆 vs Per-Agent 记忆

DeerFlow 的记忆系统支持两种粒度。`_get_memory_file_path` 函数根据是否传入 `agent_name` 来决定存储路径：

```python
def _get_memory_file_path(agent_name: str | None = None) -> Path:
    if agent_name is not None:
        return get_paths().agent_memory_file(agent_name)
    config = get_memory_config()
    if config.storage_path:
        p = Path(config.storage_path)
        return p if p.is_absolute() else get_paths().base_dir / p
    return get_paths().memory_file
```

- **全局记忆**（`agent_name=None`）：所有 Agent 共享的用户画像，存储在 `memory.json`。
- **Per-Agent 记忆**（`agent_name="coder"` 等）：特定 Agent 的专属记忆，存储在独立文件中。

这种设计允许通用信息（如用户身份、语言偏好）全局共享，而领域特定知识（如编码风格偏好）由对应的 Agent 独立维护。

## 11.5 文件缓存机制：mtime 检测

频繁读写磁盘会拖慢响应速度。DeerFlow 采用了基于文件修改时间（mtime）的缓存策略：

```python
_memory_cache: dict[str | None, tuple[dict[str, Any], float | None]] = {}

def get_memory_data(agent_name: str | None = None) -> dict[str, Any]:
    file_path = _get_memory_file_path(agent_name)
    try:
        current_mtime = file_path.stat().st_mtime if file_path.exists() else None
    except OSError:
        current_mtime = None

    cached = _memory_cache.get(agent_name)
    if cached is None or cached[1] != current_mtime:
        memory_data = _load_memory_from_file(agent_name)
        _memory_cache[agent_name] = (memory_data, current_mtime)
        return memory_data
    return cached[0]
```

缓存字典 `_memory_cache` 以 `agent_name` 为键，值是 `(memory_data, file_mtime)` 的元组。每次读取时比较当前文件的 mtime 与缓存中的 mtime，仅在文件被修改后才重新加载。这种方式既保证了数据新鲜度，又避免了不必要的 I/O。

## 11.6 max_injection_tokens 限制

记忆注入系统提示词时不能无限膨胀。`MemoryConfig` 通过 `max_injection_tokens` 控制上限：

```python
max_injection_tokens: int = Field(
    default=2000,
    ge=100,
    le=8000,
    description="Maximum tokens to use for memory injection",
)
```

在 `prompt.py` 的 `format_memory_for_injection` 中，使用 tiktoken 精确计算 token 数，超出限制时按比例截断：

```python
token_count = _count_tokens(result)
if token_count > max_tokens:
    char_per_token = len(result) / token_count
    target_chars = int(max_tokens * char_per_token * 0.95)
    result = result[:target_chars] + "\n..."
```

默认 2000 tokens 大约可以容纳用户画像、近期历史和若干关键 facts，足以让 Agent "认出"用户而不会占据过多的上下文窗口。

## 11.7 完整配置一览

`MemoryConfig` 的全部字段如下：

```python
class MemoryConfig(BaseModel):
    enabled: bool = True                    # 总开关
    storage_path: str = ""                  # 自定义存储路径
    debounce_seconds: int = 30              # 防抖等待时间（1-300s）
    model_name: str | None = None           # 记忆更新使用的模型
    max_facts: int = 100                    # 最大 facts 数量（10-500）
    fact_confidence_threshold: float = 0.7  # 置信度阈值
    injection_enabled: bool = True          # 是否注入系统提示词
    max_injection_tokens: int = 2000        # 注入 token 上限（100-8000）
```

当 `max_facts` 上限被触及时，系统会按置信度排序保留 top-N：

```python
if len(current_memory["facts"]) > config.max_facts:
    current_memory["facts"] = sorted(
        current_memory["facts"],
        key=lambda f: f.get("confidence", 0),
        reverse=True,
    )[: config.max_facts]
```

低置信度的 facts 会被自然淘汰，确保记忆库始终保留最有价值的信息。

## 11.8 memory.json 完整结构示例

前面几节分别介绍了三层数据模型的骨架，但空结构不足以建立直觉。下面给出一个经过多轮对话积累后的真实 `memory.json` 示例，读者可以对照各字段的实际填充效果：

```json
{
  "version": "1.0",
  "lastUpdated": "2025-06-15T10:23:45Z",
  "user": {
    "workContext": {
      "summary": "字节跳动高级工程师，主导 DeerFlow 框架开发，技术栈以 Python + LangChain + FastAPI 为核心，同时熟悉 TypeScript 前端开发。",
      "updatedAt": "2025-06-15T10:23:45Z"
    },
    "personalContext": {
      "summary": "中英文双语，偏好简洁直接的技术沟通风格，对 Vim 和终端工具链有强烈偏好。",
      "updatedAt": "2025-06-14T08:12:30Z"
    },
    "topOfMind": {
      "summary": "正在准备 DeerFlow 2.0 的开源发布，重点关注文档完善和 MCP 扩展生态。同时在优化 Sub-Agent 的并发调度策略，目标是将任务完成时间缩短 40%。近期还在评估 Claude 和 GPT-4o 作为默认模型的性价比。",
      "updatedAt": "2025-06-15T10:23:45Z"
    }
  },
  "history": {
    "recentMonths": {
      "summary": "过去两个月主要在重构 Agent 中间件管道，将原有的硬编码流程迁移到可插拔的 Middleware 架构。完成了 MemoryMiddleware、ToolFilterMiddleware 和 CheckpointerMiddleware 的实现与测试。同时在 CI 中引入了端到端的 Agent 行为回归测试，覆盖率从 62% 提升到 85%。",
      "updatedAt": "2025-06-15T10:23:45Z"
    },
    "earlierContext": {
      "summary": "2025 年初完成了 DeerFlow 1.0 到 2.0 的架构迁移，核心变化包括从单体 Agent 拆分为 Lead/Sub-Agent 双层架构，以及引入 LangGraph 作为流程编排引擎。期间还主导了内部 Hackathon，产出了三个基于 DeerFlow 的概念验证项目。",
      "updatedAt": "2025-06-01T15:30:00Z"
    },
    "longTermBackground": {
      "summary": "5 年 Python 后端开发经验，从 Django 转型到 AI Agent 领域。在加入字节跳动之前曾在一家 NLP 初创公司负责对话系统的后端服务开发，对大规模并发和分布式架构有实践经验。",
      "updatedAt": "2025-05-20T09:00:00Z"
    }
  },
  "facts": [
    {
      "id": "fact_a1b2c3d4",
      "content": "偏好使用 Vim 进行代码编辑，已使用超过 3 年",
      "category": "preference",
      "confidence": 0.95,
      "createdAt": "2025-06-10T14:20:00Z",
      "source": "thread_abc123"
    },
    {
      "id": "fact_e5f6g7h8",
      "content": "项目中使用 PostgreSQL 作为 Checkpointer 后端",
      "category": "knowledge",
      "confidence": 0.85,
      "createdAt": "2025-06-12T11:30:00Z",
      "source": "thread_def456"
    }
  ]
}
```

注意几个细节：`topOfMind` 的 `updatedAt` 与顶层 `lastUpdated` 一致，说明这是最近一次更新中被修改的字段；而 `personalContext` 的时间戳较早，意味着该字段已经稳定了一段时间。`facts` 数组中的 `source` 字段指向产生该 fact 的对话线程 ID，方便后续溯源和去重。

## 11.9 Confidence 评分的工作机制

11.3 节简要提到了置信度阈值，这里深入解析 LLM 如何为每条 fact 打分。关键在于 `prompt.py` 中的 `MEMORY_UPDATE_PROMPT`——它向 LLM 提供了明确的评分指南，而非让模型自由发挥。

**0.9-1.0 分段：用户明确陈述。** 当用户在对话中直接说出"我在做 X 项目"、"我的角色是 Y"这类第一人称断言时，LLM 应给予最高置信度。这类信息几乎没有歧义，直接来自用户本人的声明。

**0.7-0.8 分段：强烈暗示。** 用户虽未直接陈述，但通过反复讨论某项技术、多次执行同一类操作等行为模式，可以高度推断的信息。例如用户连续五次让 Agent 用 Python 写代码而从未选择其他语言，可以推断其偏好 Python。

**0.5-0.6 分段：稀疏推测。** 仅从少量证据中推断出的信息，应当慎用。Prompt 明确指示 LLM 只在识别到清晰模式时才使用这个分段。

0.7 阈值的实际效果是：只有"明确陈述"和"强烈暗示"两个分段的 fact 能够存活。在 `_apply_updates` 方法中，低于阈值的 fact 被静默丢弃，不会产生任何日志或通知。当 `max_facts` 上限触发时，系统按 confidence 降序排列，仅保留 top-N 条目——这意味着 0.7 分的 fact 会比 0.95 分的 fact 更早被淘汰，形成了一个自然的优先级梯度。

## 11.10 max_injection_tokens 的计算方式

11.6 节展示了截断的代码片段，这里补充完整的 token 计算流程。`format_memory_for_injection()` 内部调用 `_count_tokens()` 函数，该函数首先尝试加载 tiktoken 库并使用 `cl100k_base` 编码器——这是 GPT-4 和 GPT-3.5 系列共用的 tokenizer。如果运行环境中未安装 tiktoken，则回退到 `len(text) / 4` 的粗略估算。

格式化过程按照严格的优先级顺序拼接各部分内容。首先是用户画像区块，依次写入 `workContext`、`personalContext` 和 `topOfMind` 的摘要；然后是历史区块，依次写入 `recentMonths`、`earlierContext` 和 `longTermBackground`。这个顺序反映了信息的即时重要性——"用户是谁"比"用户过去做了什么"更关键。

当拼接结果的 token 数超过 `max_injection_tokens`（默认 2000）时，系统根据 `char_per_token = len(result) / token_count` 计算字符与 token 的比率，然后乘以目标 token 数再乘以 0.95 的安全系数，得到截断点字符数。最终结果被包裹在 `<memory>...</memory>` XML 标签中注入系统提示词。0.95 的安全系数确保截断后的实际 token 数不会因为字符到 token 映射的非线性而意外超限。

## 11.11 per-agent 记忆 vs 全局记忆

11.4 节介绍了两种记忆粒度的存储路径，这里进一步分析其使用场景和数据流。

**全局记忆**（`agent_name=None`）存储在 `{base_dir}/memory.json`，包含跨 Agent 通用的用户信息：身份、语言偏好、沟通风格等。无论用户与哪个 Agent 交互，这些信息都应该被感知到。

**Per-Agent 记忆**（如 `agent_name="assistant"`）存储在 `{base_dir}/agents/assistant/memory.json`，包含该 Agent 特有的上下文。典型场景是：编码 Agent 记住用户的代码风格偏好（缩进方式、命名约定、测试框架选择），而写作 Agent 记住用户的文风偏好（正式程度、段落长度、术语使用）。两者互不干扰。

`MemoryMiddleware` 在初始化时接收 `agent_name` 参数，该值来自 Lead Agent 的配置。当中间件触发记忆更新时，会将 `agent_name` 传递给 `update_memory()` 和 `get_memory_data()`，从而定位到正确的 memory 文件。两种记忆使用完全相同的数据结构和更新机制（`_apply_updates`），区别仅在于文件路径。这种设计使得记忆系统的核心逻辑无需为不同粒度编写不同代码，降低了维护成本。

## 11.12 记忆注入的时机与格式

记忆数据最终要进入 LLM 的上下文窗口才能发挥作用。注入发生在 `lead_agent/prompt.py` 的 `apply_prompt_template()` 函数中：该函数在构建完整的系统提示词时，调用 `_get_memory_context(agent_name)` 加载并格式化记忆数据，然后通过 `SYSTEM_PROMPT_TEMPLATE` 中的 `{memory_context}` 占位符将其插入。

注入后的记忆区块具有如下格式：

```
<memory>
User Context:
- Work: [workContext summary]
- Personal: [personalContext summary]
- Current Focus: [topOfMind summary]

History:
- Recent: [recentMonths summary]
- Earlier: [earlierContext summary]
</memory>
```

使用 XML 标签包裹有两个好处：一是让 LLM 能够清晰地区分记忆内容与其他系统指令；二是方便后续做 token 统计和调试日志的提取。

注入受两个条件门控：`injection_enabled` 必须为 `True`，且实际存在非空的记忆数据。若记忆文件为空或不存在，`{memory_context}` 占位符会被替换为空字符串，不会在系统提示词中留下任何痕迹。

值得注意的是，Sub-Agent 的流水线中不包含 `MemoryMiddleware`，因此它们不会接收记忆注入。这是有意为之——Sub-Agent 执行的是具体的工具调用任务（搜索、代码执行等），它们需要的上下文由 Lead Agent 在任务分发时显式传递，而非从长期记忆中隐式获取。这种分离避免了记忆信息在多层 Agent 间重复注入导致的 token 浪费。

## 小结

DeerFlow 的长期记忆架构通过三层数据模型（用户画像、时间线、事实库）完整地刻画了用户的身份、历史和碎片化知识。五种 fact 类别覆盖了从偏好到目标的全部维度，0.7 的置信度阈值在信息保留与噪声过滤之间取得了平衡。mtime 缓存避免了不必要的磁盘 I/O，`max_injection_tokens` 防止记忆注入占用过多上下文窗口。全局记忆与 per-agent 记忆的双轨设计，则在信息共享与领域隔离之间找到了恰当的折中。下一章我们将深入记忆更新的流水线——从对话结束到 `memory.json` 发生变化，中间究竟经历了哪些步骤。
