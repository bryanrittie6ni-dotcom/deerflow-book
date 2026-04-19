# 第 5 章　Lead Agent：大脑的核心循环

在 DeerFlow 的架构中，Lead Agent 是整个系统的"大脑"。它接收用户消息、选择合适的模型、组装工具集、挂载中间件管道，最终通过 `create_agent()` 创建一个完整的可执行 Agent。本章深入剖析这一核心创建过程。

## 5.1 `make_lead_agent`：一切从这里开始

`make_lead_agent` 是 Lead Agent 的工厂函数，位于 `backend/packages/harness/deerflow/agents/lead_agent/agent.py`。它从 `RunnableConfig` 中提取运行时参数，完成模型解析、工具组装、中间件构建和 Prompt 模板渲染，最终调用 `create_agent()`。

```python
def make_lead_agent(config: RunnableConfig):
    from deerflow.tools import get_available_tools
    from deerflow.tools.builtins import setup_agent

    cfg = config.get("configurable", {})

    thinking_enabled = cfg.get("thinking_enabled", True)
    reasoning_effort = cfg.get("reasoning_effort", None)
    requested_model_name: str | None = cfg.get("model_name") or cfg.get("model")
    is_plan_mode = cfg.get("is_plan_mode", False)
    subagent_enabled = cfg.get("subagent_enabled", False)
    max_concurrent_subagents = cfg.get("max_concurrent_subagents", 3)
    agent_name = cfg.get("agent_name")

    # ...模型解析、配置校验...

    return create_agent(
        model=create_chat_model(name=model_name, thinking_enabled=thinking_enabled,
                                reasoning_effort=reasoning_effort),
        tools=get_available_tools(model_name=model_name,
                                  groups=agent_config.tool_groups if agent_config else None,
                                  subagent_enabled=subagent_enabled),
        middleware=_build_middlewares(config, model_name=model_name, agent_name=agent_name),
        system_prompt=apply_prompt_template(subagent_enabled=subagent_enabled,
                                            max_concurrent_subagents=max_concurrent_subagents,
                                            agent_name=agent_name),
        state_schema=ThreadState,
    )
```

`create_agent()` 接收五个核心参数：

| 参数 | 说明 |
|------|------|
| `model` | LLM 实例，由 `create_chat_model` 创建 |
| `tools` | 可用工具列表，动态组装 |
| `middleware` | 中间件链，处理所有 Cross-cutting Concerns |
| `system_prompt` | 系统提示词，包含角色、技能、记忆等上下文 |
| `state_schema` | 状态模式，即 `ThreadState` |

## 5.2 模型选择与 Fallback 策略

模型解析经过三层优先级：请求参数 > 自定义 Agent 配置 > 全局默认模型。`_resolve_model_name` 负责安全回退：

```python
def _resolve_model_name(requested_model_name: str | None = None) -> str:
    app_config = get_app_config()
    default_model_name = app_config.models[0].name if app_config.models else None
    if default_model_name is None:
        raise ValueError("No chat models are configured.")

    if requested_model_name and app_config.get_model_config(requested_model_name):
        return requested_model_name

    if requested_model_name and requested_model_name != default_model_name:
        logger.warning(f"Model '{requested_model_name}' not found; "
                       f"fallback to '{default_model_name}'.")
    return default_model_name
```

这个设计确保了即使用户请求了一个不存在的模型名称，系统也不会崩溃，而是静默降级到默认模型。

## 5.3 Thinking 模式 vs 普通模式

DeerFlow 支持"思考模式"（Thinking Mode），让模型在回答前进行深度推理。`make_lead_agent` 中有一段关键的兼容性检查：

```python
if thinking_enabled and not model_config.supports_thinking:
    logger.warning(f"Thinking mode is enabled but model '{model_name}' "
                   "does not support it; fallback to non-thinking mode.")
    thinking_enabled = False
```

在 `create_chat_model`（`backend/packages/harness/deerflow/models/factory.py`）中，Thinking 模式的开关通过 `when_thinking_enabled` 配置项传递给模型构造函数。当 Thinking 关闭时，系统还会主动向模型发送 `{"thinking": {"type": "disabled"}}` 以确保推理能力被彻底关闭，避免不必要的 token 消耗。

## 5.4 工具集的动态组装

工具组装逻辑位于 `backend/packages/harness/deerflow/tools/tools.py` 的 `get_available_tools`。合并顺序与条件大致为：**`config.tools` 解析出的社区/沙箱工具** + **内置**（`present_files`、`ask_clarification`；可选 `task`、`view_image`）+ **MCP 工具**（或 **`tool_search` 开启时的延迟注册**，见下）。

```23:101:backend/packages/harness/deerflow/tools/tools.py
def get_available_tools(
    groups: list[str] | None = None,
    include_mcp: bool = True,
    model_name: str | None = None,
    subagent_enabled: bool = False,
) -> list[BaseTool]:
    ...
    loaded_tools = [resolve_variable(tool.use, BaseTool) for tool in config.tools if groups is None or tool.group in groups]
    ...
    if subagent_enabled:
        builtin_tools.extend(SUBAGENT_TOOLS)
    ...
    if model_config is not None and model_config.supports_vision:
        builtin_tools.append(view_image_tool)
    ...
    if include_mcp:
        ...
        if config.tool_search.enabled:
            ...
            builtin_tools.append(tool_search_tool)
    ...
    return loaded_tools + builtin_tools + mcp_tools
```

当 **`tool_search.enabled: true`** 且存在 MCP 工具时：MCP 工具进入 **`DeferredToolRegistry`**，列表里仍会带上它们（供 **ToolNode** 执行），但 **`DeferredToolFilterMiddleware`** 在每次 **`wrap_model_call`** 里会把「延迟工具」从 **`request.tools` 里摘掉**，使 **`bind_tools` 只绑定「活跃」schema；模型通过系统提示里的 **`<available-deferred-tools>`** 知道名字，再调用 **`tool_search`** 拉取完整定义（见 `deferred_tool_filter_middleware.py`、`tool_search.py`）。

注意 MCP 与扩展状态使用 **`ExtensionsConfig.from_file()`** 读取，便于 Gateway 热更新。

## 5.5 ThreadState 详解

`ThreadState` 是 Lead Agent 的状态模式，定义了对话线程中需要持久化的所有数据。它继承自 LangChain 的 `AgentState`（自带 `messages` 字段），并扩展了多个业务字段：

```python
class ThreadState(AgentState):
    sandbox: NotRequired[SandboxState | None]
    thread_data: NotRequired[ThreadDataState | None]
    title: NotRequired[str | None]
    artifacts: Annotated[list[str], merge_artifacts]
    todos: NotRequired[list | None]
    uploaded_files: NotRequired[list[dict] | None]
    viewed_images: Annotated[dict[str, ViewedImageData], merge_viewed_images]
```

各字段的职责：

- **`sandbox`**：沙箱环境状态，包含 `sandbox_id`，由 `SandboxMiddleware` 管理。
- **`thread_data`**：线程数据目录路径（workspace/uploads/outputs），由 `ThreadDataMiddleware` 初始化。
- **`title`**：对话标题，由 `TitleMiddleware` 在首次交互后自动生成。
- **`artifacts`**：产出物路径列表，使用自定义 reducer `merge_artifacts` 实现去重合并。
- **`todos`**：Plan Mode 下的任务列表，由 `TodoMiddleware` 维护。
- **`uploaded_files`**：用户上传的文件元数据，由 `UploadsMiddleware` 注入。
- **`viewed_images`**：已查看的图片数据（含 base64），由 `ViewImageMiddleware` 使用。

其中 `artifacts` 和 `viewed_images` 使用了 LangGraph 的 Annotated reducer 模式。以 `merge_artifacts` 为例：

```python
def merge_artifacts(existing: list[str] | None, new: list[str] | None) -> list[str]:
    if existing is None:
        return new or []
    if new is None:
        return existing
    return list(dict.fromkeys(existing + new))  # 去重且保序
```

每次 state 更新时，LangGraph 不会直接覆盖 `artifacts`，而是调用这个 reducer 将新旧值合并。这保证了多个中间件或工具调用产生的 artifacts 不会互相覆盖。

`merge_viewed_images` 还支持一个特殊语义：当 `new` 为空字典 `{}` 时，表示清空所有已查看的图片，这让 `ViewImageMiddleware` 可以在处理完图片后重置状态。

## 5.6 系统提示词的模板化

`apply_prompt_template` 函数（`backend/packages/harness/deerflow/agents/lead_agent/prompt.py`）将多个动态片段注入到 `SYSTEM_PROMPT_TEMPLATE` 中：

```python
def apply_prompt_template(subagent_enabled=False, max_concurrent_subagents=3,
                          *, agent_name=None, available_skills=None) -> str:
    memory_context = _get_memory_context(agent_name)
    subagent_section = _build_subagent_section(n) if subagent_enabled else ""
    skills_section = get_skills_prompt_section(available_skills)

    prompt = SYSTEM_PROMPT_TEMPLATE.format(
        agent_name=agent_name or "DeerFlow 2.0",
        soul=get_agent_soul(agent_name),
        skills_section=skills_section,
        memory_context=memory_context,
        subagent_section=subagent_section,
        # ...
    )
    return prompt + f"\n<current_date>{datetime.now().strftime('%Y-%m-%d, %A')}</current_date>"
```

系统提示词包含六大模块：角色定义（`<role>`）、思考风格（`<thinking_style>`）、澄清机制（`<clarification_system>`）、技能系统（`<skill_system>`）、Sub-agent 编排指令（`<subagent_system>`）以及响应风格（`<response_style>`）。每个模块都是条件注入的，例如只有当 `subagent_enabled=True` 时才会包含 Sub-agent 相关的指令。

## 5.7 ReAct 循环里「可能调用哪些工具」？谁来做选择？数量会不会太多？

在 **`create_agent`** 的典型循环里，流程是：**模型输出 → 可能产生 `tool_calls` → 工具执行 → 结果写入 `ToolMessage` → 再进模型**。下面把「工具从哪来、谁挑、有多少、多了怎么办」收拢成一处，便于和架构文档对照。

### 5.7.1 谁在「选择」工具？

**没有**单独的规则引擎或分类器替模型决定下一步工具。候选集在进程内先被 **代码** 收窄（见 5.7.2），再交给 **LLM**：模型看到的是当前轮 **`bind_tools`** 绑定的若干工具的 **名称 + 描述 + 参数 schema**，据此在生成内容里输出 **`tool_calls`**。因此「选哪个工具」本质上是 **模型的函数调用决策**，受 **工具文案质量** 与 **对话上下文** 影响；**`tool_search`** 场景下，模型还可先搜延迟工具，再在后续轮次发起调用。

### 5.7.2 代码侧如何收窄候选（不是模型）

| 机制 | 作用 |
|------|------|
| **`get_available_tools(..., groups=agent_config.tool_groups)`** | 只加载 **`config.tools` 中 `group` 命中** 的条目；`groups is None` 时等于 **YAML 里声明的全表**。 |
| **`subagent_enabled`** | 为 **True** 时才把 **`task`** 放进内置列表。 |
| **`supports_vision`** | 为 **True** 时才附加 **`view_image`**。 |
| **MCP / `include_mcp`** | 无可用 MCP 时列表为空；有则追加（数量随你接入的服务而变）。 |
| **`tool_search.enabled`** | MCP 工具进 **延迟注册**；**`DeferredToolFilterMiddleware`** 让模型 **绑定** 时 **看不到** 这些工具的完整 schema，只通过提示中的名字 + **`tool_search`** 按需拉取（单次搜索最多 **`MAX_RESULTS = 5`** 条匹配，见 `tool_search.py`）。 |

以上决定 **「本轮可能出现在工具列表里的工具」**；**Skills 不是工具**，不占用 `bind_tools` 槽位，而是通过 **`<skill_system>`** 列出元数据，由模型在需要时 **`read_file`** 渐进加载（见 `get_skills_prompt_section`）。

### 5.7.3 项目里大概有多少 tools / skills？（可随配置变化）

- **YAML 声明**：以仓库根目录 **`config.yaml`** 为例，**`tools:` 下列了 8 条**（`web_search`、`web_fetch`、`image_search`、`ls`、`read_file`、`write_file`、`str_replace`、`bash`）。你增删条目或换用 **`config.example.yaml`** 里另一套组合时，**数量随之变化**。
- **内置（始终或条件）**：至少 **`present_files`**、**`ask_clarification`**；可选 **`task`**、**`view_image`**；**`tool_search` 开启时** 多 **`tool_search`**。
- **代码库里 `@tool` 定义**：`deerflow` 包内可检索到的独立工具有限（社区 Tavily/Jina/图搜、沙箱 5 件、内置若干等）；**真正挂载数量**仍由 **`config.tools` 的 `use:` 指向哪几个实现** 决定，而不是「仓库里有多少个 `@tool` 就全部上线」。
- **Skills**：约定目录 **`skills/{public,custom}/.../SKILL.md`**。当前仓库 **`skills/public` 下共 21 个 `SKILL.md`**（若你本地新增/删除目录，请以实际扫描为准）。**`get_skills_prompt_section`** 内部 **`load_skills(enabled_only=True)`**，只把 **启用** 的技能写进提示；启用状态来自 **`ExtensionsConfig`**（与 Gateway 一致），加载失败时 **默认全部启用**（见 `skills/loader.py`）。

统计数字仅作 **当前仓库快照**；交付环境请以 **`config.yaml` + 扩展配置 + MCP** 为准。

### 5.7.4 工具 / Skills 太多会不会影响「选择」？

**会，但分两层：**

1. **对模型**：同时绑定的工具 **越多**，每条 **name/description/schema** 占用的 **上下文** 越大，更容易出现 **选错工具、漏工具、或过度依赖某几个名字好记的工具**。这是通用 LLM+Tools 现象，不是 DeerFlow 独有。
2. **对本项目的缓解**：不是靠再套一层小模型做路由，而是 **配置 + 中间件 + 提示词结构** 三件事；**设计意图与代码路径** 见 **§5.8**。

若仍嫌多，可 **收紧 `tool_groups`**、**减少 MCP 接入**、在扩展配置里 **关掉不用的 skills**，或 **拆成多个专用 Agent**（不同 `agent_name` / 不同 `tool_groups`）。

## 5.8 三类缓解详解：tool_groups、tool_search 延迟绑定、Skills 渐进加载

下面按 **数据从哪来 → 在图的哪一步生效 → 关键源码** 说明，便于和 LangGraph / `create_agent` 的执行模型对齐。

### 5.8.1 `tool_groups`：按自定义 Agent 裁剪「全局 YAML 工具表」

**目标**：根目录 **`config.yaml`** 的 **`tools:`** 往往是一张「全站能力表」；不同产品形态下的 Lead（例如「只做检索」vs「读写仓库」）不应每次都把整张表绑给模型。

**配置入口**：

- **分组定义**：根配置里 **`tool_groups`** 列出合法组名；每条 **`tools:`** 条目带 **`group:`**（如 `web`、`file:read`），与组名对应。
- **Agent 级选用哪些组**：自定义 Agent 目录 **`agents/<agent_name>/config.yaml`** 中字段 **`tool_groups`**，由 **`AgentConfig`** 建模为 **`list[str] | None`**。

```18:24:backend/packages/harness/deerflow/config/agents_config.py
class AgentConfig(BaseModel):
    """Configuration for a custom agent."""

    name: str
    description: str = ""
    model: str | None = None
    tool_groups: list[str] | None = None
```

**核心流程**：

1. 请求里带 **`agent_name`** 时，`make_lead_agent` **`load_agent_config(agent_name)`** 读出 **`tool_groups`**。
2. 创建 Lead 时把 **`groups=agent_config.tool_groups`** 传给 **`get_available_tools`**（无自定义 Agent 时 **`groups` 为 `None`**）。
3. **`get_available_tools`** 只对 **`config.tools`** 做过滤：**`tool.group in groups`**；**未命中组的 YAML 条目不会实例化进 `loaded_tools`**。

```43:44:backend/packages/harness/deerflow/tools/tools.py
    config = get_app_config()
    loaded_tools = [resolve_variable(tool.use, BaseTool) for tool in config.tools if groups is None or tool.group in groups]
```

```331:337:backend/packages/harness/deerflow/agents/lead_agent/agent.py
    return create_agent(
        model=create_chat_model(name=model_name, thinking_enabled=thinking_enabled, reasoning_effort=reasoning_effort),
        tools=get_available_tools(model_name=model_name, groups=agent_config.tool_groups if agent_config else None, subagent_enabled=subagent_enabled),
        middleware=_build_middlewares(config, model_name=model_name, agent_name=agent_name),
        system_prompt=apply_prompt_template(subagent_enabled=subagent_enabled, max_concurrent_subagents=max_concurrent_subagents, agent_name=agent_name),
        state_schema=ThreadState,
    )
```

**重要边界（避免误解）**：

- **`tool_groups` 只裁剪根配置里的 `config.tools`**，**不**裁剪 **`present_files` / `ask_clarification`**，**不**裁剪 **`task` / `view_image`**（后者由运行时开关与模型能力决定），也**不**裁剪 **MCP 工具条数**（MCP 仍整批进入 `mcp_tools` 列表；若需压缩 MCP 上下文，应配合 **§5.8.2** 的 **`tool_search`**）。

### 5.8.2 `tool_search` + 延迟绑定：MCP 仍注册在 ToolNode，但不默认进 `bind_tools`

**目标**：MCP 一接就是几十上百个工具时，若全部把 **完整 JSON Schema** 塞进每轮 **`bind_tools`**，上下文与误选压力都大。本项目的做法是：**执行侧仍持有全量工具对象**，**推理侧默认只看到「活跃工具」+ 延迟工具「名字清单」+ 一个 `tool_search` 工具**。

**配置入口**：根 **`config.yaml`**（或等价配置）中 **`tool_search.enabled: true`**，且扩展里 **启用 MCP**、`get_cached_mcp_tools()` 非空。

**核心流程（组装阶段）**——在 **`get_available_tools`** 内：

1. 与往常一样拉取 **`mcp_tools`**。
2. 若 **`config.tool_search.enabled`**：为每个 MCP 工具 **`registry.register(t)`**，**`set_deferred_registry(registry)`**，并把 **`tool_search`** 追加进 **`builtin_tools`**。
3. **返回值仍是** **`loaded_tools + builtin_tools + mcp_tools`**：即 **MCP 工具对象仍在 Agent 的 `tools` 列表里**，LangGraph 的 **ToolNode** 能按 **name** 路由到真实实现（含延迟工具）。

```83:101:backend/packages/harness/deerflow/tools/tools.py
                    if config.tool_search.enabled:
                        from deerflow.tools.builtins.tool_search import DeferredToolRegistry, set_deferred_registry
                        from deerflow.tools.builtins.tool_search import tool_search as tool_search_tool

                        registry = DeferredToolRegistry()
                        for t in mcp_tools:
                            registry.register(t)
                        set_deferred_registry(registry)
                        builtin_tools.append(tool_search_tool)
                        logger.info(f"Tool search active: {len(mcp_tools)} tools deferred")
        ...
    return loaded_tools + builtin_tools + mcp_tools
```

**核心流程（每轮调模型前）**——**`DeferredToolFilterMiddleware`** 挂在 Lead 的 **`_build_middlewares`** 里（仅当 **`tool_search.enabled`**）：

- 在 **`wrap_model_call` / `awrap_model_call`** 里，从 **`request.tools` 中去掉所有「注册在延迟表里的工具名」**，再交给内层 **`handler`**。
- 效果：**传给 LLM 的 `bind_tools` 集合变小**；延迟 MCP **不在**默认 schema 里，但 **仍在**外层 `create_agent(..., tools=...)` 的全列表中，供执行阶段使用。

```31:44:backend/packages/harness/deerflow/agents/middlewares/deferred_tool_filter_middleware.py
    def _filter_tools(self, request: ModelRequest) -> ModelRequest:
        from deerflow.tools.builtins.tool_search import get_deferred_registry

        registry = get_deferred_registry()
        if not registry:
            return request

        deferred_names = {e.name for e in registry.entries}
        active_tools = [t for t in request.tools if getattr(t, "name", None) not in deferred_names]

        if len(active_tools) < len(request.tools):
            logger.debug(f"Filtered {len(request.tools) - len(active_tools)} deferred tool schema(s) from model binding")

        return request.override(tools=active_tools)
```

```243:246:backend/packages/harness/deerflow/agents/lead_agent/agent.py
    if app_config.tool_search.enabled:
        from deerflow.agents.middlewares.deferred_tool_filter_middleware import DeferredToolFilterMiddleware
        middlewares.append(DeferredToolFilterMiddleware())
```

**核心流程（提示词侧）**——**`get_deferred_tools_prompt_section()`** 在 **`apply_prompt_template`** 中注入 **`{deferred_tools_section}`**：仅列出延迟工具 **name**，告诉模型「还有哪些可调」，需用 **`tool_search`** 拉 **完整 OpenAI function 形态定义**（单次最多 **`MAX_RESULTS = 5`** 条匹配，见 **`tool_search.py`**）。

```422:444:backend/packages/harness/deerflow/agents/lead_agent/prompt.py
def get_deferred_tools_prompt_section() -> str:
    ...
    registry = get_deferred_registry()
    if not registry:
        return ""

    names = "\n".join(e.name for e in registry.entries)
    return f"<available-deferred-tools>\n{names}\n</available-deferred-tools>"
```

**运行时闭环（概念上）**：

1. 模型在 **较小** 的默认工具集上规划；若意图需要某 MCP 能力，从 **`<available-deferred-tools>`** 看到名字。
2. 调用 **`tool_search`**（带 `select:...`、关键字或正则查询），在 **ToolMessage** 中拿到 **至多 5 条** 工具的完整定义 JSON。
3. 后续轮次模型依据 **对话里已出现的 schema** 生成对应 **`tool_calls`**；ToolNode 因 **全量 `tools` 列表** 仍包含这些 **BaseTool**，可正常执行。

### 5.8.3 Skills：只在 system prompt 里放「目录 + 路径」，正文用 `read_file` 渐进拉取

**目标**：Skills 若把每个 **`SKILL.md` 全文** 都拼进 system prompt，会与「工具过多」同类问题：**提示极长、角色指令被冲淡、成本高**。本项目采用 **「元数据进提示、正文走文件工具」**。

**核心流程**：

1. **`get_skills_prompt_section`** 内 **`load_skills(enabled_only=True)`**，扫描 **`skills/public` 与 `skills/custom`** 下各 **`SKILL.md`**，解析 frontmatter 得到 **name / description**。
2. 为每个 skill 生成 **`<skill>`** 块：含 **`<name>`**、**`<description>`**、**`<location>`**（容器内路径，来自 **`get_container_file_path(container_base_path)`**，默认与配置 **`skills.container_path`** 一致，如 **`/mnt/skills`**）。
3. 同一段提示中写明 **Progressive Loading Pattern**：匹配用户意图 → **`read_file` 读 `location` 指向的主文件** → 按文内引用再按需读同目录资源。

```370:411:backend/packages/harness/deerflow/agents/lead_agent/prompt.py
def get_skills_prompt_section(available_skills: set[str] | None = None) -> str:
    ...
    skills = load_skills(enabled_only=True)
    ...
    skill_items = "\n".join(
        f"    <skill>\n        <name>{skill.name}</name>\n        <description>{skill.description}</description>\n        <location>{skill.get_container_file_path(container_base_path)}</location>\n    </skill>" for skill in skills
    )
    skills_list = f"<available_skills>\n{skill_items}\n</available_skills>"

    return f"""<skill_system>
You have access to skills that provide optimized workflows for specific tasks. ...
**Progressive Loading Pattern:**
1. When a user query matches a skill's use case, immediately call `read_file` on the skill's main file using the path attribute provided in the skill tag below
...
{skills_list}

</skill_system>"""
```

**与工具的关系**：Skills **不注册为 LangChain `BaseTool`**；模型用的是已有 **`read_file`**（或其它文件工具）去读 **`location`**。**Bootstrap** 等特殊流程可通过 **`available_skills=set(["bootstrap"])`** 只注入子集（见 **`make_lead_agent` 的 `is_bootstrap` 分支**）。

**小结（三者对比）**

| 机制 | 主要削减什么 | 生效位置 |
|------|----------------|----------|
| **`tool_groups`** | 根 **`config.tools`** 中未入选组的条目 | **`get_available_tools`** 过滤 `loaded_tools` |
| **`tool_search`** | 延迟 MCP 的 **schema 默认不进模型** | **注册表 + 全量 `tools` 列表**；**`DeferredToolFilterMiddleware`** 改 **`request.tools`**；提示 **`available-deferred-tools`** + **`tool_search`** |
| **Skills 渐进加载** | SKILL **正文**不进默认 system prompt | **`get_skills_prompt_section`** 只注入元数据 + **`read_file`** 约定 |

## 小结

Lead Agent 的创建过程体现了 DeerFlow 的核心设计理念：

1. **三层模型解析**：请求参数 > Agent 配置 > 全局默认，层层降级保证可用性。
2. **动态工具组装**：配置工具 + MCP 工具 + 内置工具 + 条件工具，按需组合；**`tool_search`** 时对 MCP 做 **延迟暴露**，配合中间件减小默认 **bind_tools** 体积。
3. **类型安全的状态管理**：`ThreadState` 通过 TypedDict + Annotated reducer 实现可预测的状态合并。
4. **模板化提示词**：系统提示词根据运行时参数动态生成；**Skills** 以列表 + 路径形式注入，**不占工具槽**，需用时再 **`read_file`**。
5. **工具「选择」**：候选集由 **`get_available_tools` + 中间件** 收窄，**具体调用哪个**由 **模型** 根据 schema 与对话决定（**5.7**）；工具过多主要带来 **上下文与误选** 压力，可用 **分组 / 延迟加载 / 关 skill** 缓解。
6. **三类缓解的实现细节**：**`tool_groups`** 只筛 YAML 工具；**`tool_search`** 把 MCP 从默认 **`bind_tools`** 中剥离但保留 ToolNode 执行与按需检索；**Skills** 仅注入元数据并由 **`read_file`** 渐进加载（**5.8**）。

`make_lead_agent` 不是一个简单的构造函数，而是一个策略编排器——它根据运行时配置决定 Agent 的能力边界。
