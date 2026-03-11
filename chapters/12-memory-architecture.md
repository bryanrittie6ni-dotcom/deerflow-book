# 第 12 章　长期记忆架构

绝大多数 Agent 框架的会话在结束后即刻失忆——下一次对话从零开始，用户不得不反复自我介绍、重复偏好设定。DeerFlow 的做法截然不同：它在后台维护一套持久化的记忆系统，使 Agent 能够跨会话地"认识"用户、积累上下文、追踪目标。

本章将深入剖析这套记忆架构的数据模型、配置体系和缓存策略。

## 12.1 记忆的三层结构

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

## 12.2 Facts 的五种类别

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

## 12.3 Confidence 阈值：0.7 的门槛

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

## 12.4 全局记忆 vs Per-Agent 记忆

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

## 12.5 文件缓存机制：mtime 检测

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

## 12.6 max_injection_tokens 限制

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

## 12.7 完整配置一览

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

## 小结

DeerFlow 的长期记忆架构通过三层数据模型（用户画像、时间线、事实库）完整地刻画了用户的身份、历史和碎片化知识。五种 fact 类别覆盖了从偏好到目标的全部维度，0.7 的置信度阈值在信息保留与噪声过滤之间取得了平衡。mtime 缓存避免了不必要的磁盘 I/O，`max_injection_tokens` 防止记忆注入占用过多上下文窗口。全局记忆与 per-agent 记忆的双轨设计，则在信息共享与领域隔离之间找到了恰当的折中。下一章我们将深入记忆更新的流水线——从对话结束到 `memory.json` 发生变化，中间究竟经历了哪些步骤。
