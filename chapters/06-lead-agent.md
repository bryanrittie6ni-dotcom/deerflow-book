# 第 6 章　Lead Agent：大脑的核心循环

在 DeerFlow 的架构中，Lead Agent 是整个系统的"大脑"。它接收用户消息、选择合适的模型、组装工具集、挂载中间件管道，最终通过 `create_agent()` 创建一个完整的可执行 Agent。本章深入剖析这一核心创建过程。

## 6.1 `make_lead_agent`：一切从这里开始

`make_lead_agent` 是 Lead Agent 的工厂函数，位于 `backend/src/agents/lead_agent/agent.py`。它从 `RunnableConfig` 中提取运行时参数，完成模型解析、工具组装、中间件构建和 Prompt 模板渲染，最终调用 `create_agent()`。

```python
def make_lead_agent(config: RunnableConfig):
    from src.tools import get_available_tools
    from src.tools.builtins import setup_agent

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

## 6.2 模型选择与 Fallback 策略

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

## 6.3 Thinking 模式 vs 普通模式

DeerFlow 支持"思考模式"（Thinking Mode），让模型在回答前进行深度推理。`make_lead_agent` 中有一段关键的兼容性检查：

```python
if thinking_enabled and not model_config.supports_thinking:
    logger.warning(f"Thinking mode is enabled but model '{model_name}' "
                   "does not support it; fallback to non-thinking mode.")
    thinking_enabled = False
```

在 `create_chat_model`（`backend/src/models/factory.py`）中，Thinking 模式的开关通过 `when_thinking_enabled` 配置项传递给模型构造函数。当 Thinking 关闭时，系统还会主动向模型发送 `{"thinking": {"type": "disabled"}}` 以确保推理能力被彻底关闭，避免不必要的 token 消耗。

## 6.4 工具集的动态组装

工具组装逻辑位于 `backend/src/tools/tools.py` 的 `get_available_tools` 函数。DeerFlow 的工具来源有四类，最终合并为一个列表：

```python
def get_available_tools(
    groups: list[str] | None = None,
    include_mcp: bool = True,
    model_name: str | None = None,
    subagent_enabled: bool = False,
) -> list[BaseTool]:
    config = get_app_config()
    # 1. 配置文件中声明的工具（含沙箱工具）
    loaded_tools = [resolve_variable(tool.use, BaseTool)
                    for tool in config.tools
                    if groups is None or tool.group in groups]

    # 2. MCP 工具（从缓存加载，支持热更新）
    mcp_tools = []
    if include_mcp:
        extensions_config = ExtensionsConfig.from_file()  # 每次重新读取磁盘
        if extensions_config.get_enabled_mcp_servers():
            mcp_tools = get_cached_mcp_tools()

    # 3. 内置工具
    builtin_tools = BUILTIN_TOOLS.copy()  # [present_file, ask_clarification]

    # 4. Sub-agent 工具（条件启用）
    if subagent_enabled:
        builtin_tools.extend(SUBAGENT_TOOLS)  # [task_tool]

    # 5. 视觉工具（根据模型能力）
    if model_config is not None and model_config.supports_vision:
        builtin_tools.append(view_image_tool)

    return loaded_tools + builtin_tools + mcp_tools
```

注意 MCP 工具使用 `ExtensionsConfig.from_file()` 而非缓存的 `config.extensions`，这是因为 MCP 配置可能通过 Gateway API 在另一个进程中被修改。每次创建 Agent 时重新从磁盘读取，确保配置的实时性。

## 6.5 ThreadState 详解

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

## 6.6 系统提示词的模板化

`apply_prompt_template` 函数（`backend/src/agents/lead_agent/prompt.py`）将多个动态片段注入到 `SYSTEM_PROMPT_TEMPLATE` 中：

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

## 小结

Lead Agent 的创建过程体现了 DeerFlow 的核心设计理念：

1. **三层模型解析**：请求参数 > Agent 配置 > 全局默认，层层降级保证可用性。
2. **动态工具组装**：配置工具 + MCP 工具 + 内置工具 + 条件工具，按需组合。
3. **类型安全的状态管理**：`ThreadState` 通过 TypedDict + Annotated reducer 实现可预测的状态合并。
4. **模板化提示词**：系统提示词根据运行时参数动态生成，避免不必要的上下文膨胀。

`make_lead_agent` 不是一个简单的构造函数，而是一个策略编排器——它根据运行时配置决定 Agent 的能力边界。
