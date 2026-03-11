# 第 16 章　内置工具与社区工具

DeerFlow 的工具体系分为三层：**内置工具**（builtins）、**社区工具**（community）和 **MCP 扩展工具**。前两层由框架自身管理，本章将逐一拆解它们的实现细节与使用场景。

## 16.1 工具加载入口

所有工具的汇总逻辑位于 `tools/tools.py` 中的 `get_available_tools` 函数。它负责将内置工具、配置文件中声明的社区工具以及 MCP 缓存工具合并为一个统一列表：

```python
BUILTIN_TOOLS = [
    present_file_tool,
    ask_clarification_tool,
]

SUBAGENT_TOOLS = [
    task_tool,
]

def get_available_tools(
    groups: list[str] | None = None,
    include_mcp: bool = True,
    model_name: str | None = None,
    subagent_enabled: bool = False,
) -> list[BaseTool]:
    config = get_app_config()
    loaded_tools = [
        resolve_variable(tool.use, BaseTool)
        for tool in config.tools
        if groups is None or tool.group in groups
    ]

    # 获取 MCP 缓存工具
    mcp_tools = []
    if include_mcp:
        extensions_config = ExtensionsConfig.from_file()
        if extensions_config.get_enabled_mcp_servers():
            mcp_tools = get_cached_mcp_tools()

    builtin_tools = BUILTIN_TOOLS.copy()
    if subagent_enabled:
        builtin_tools.extend(SUBAGENT_TOOLS)

    # 仅当模型支持视觉时才添加 view_image_tool
    model_config = config.get_model_config(model_name)
    if model_config is not None and model_config.supports_vision:
        builtin_tools.append(view_image_tool)

    return loaded_tools + builtin_tools + mcp_tools
```

注意三个设计要点：

1. **社区工具通过 `resolve_variable` 动态加载**——配置文件中用字符串路径（如 `src.community.tavily.tools:web_search_tool`）指向具体的 `BaseTool` 实例，运行时反射解析。
2. **subagent 工具默认不加载**——只有当 Lead Agent 启用子代理模式时才注入 `task_tool`，防止子代理递归嵌套。
3. **视觉工具按需注入**——`view_image_tool` 仅在模型声明 `supports_vision=True` 时才加入工具列表。

## 16.2 内置工具详解

### 16.2.1 task — 子代理委派

`task_tool` 是 DeerFlow 多代理协作的核心枢纽。Lead Agent 通过调用该工具将复杂任务委派给专门的子代理执行：

```python
@tool("task", parse_docstring=True)
def task_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    prompt: str,
    subagent_type: Literal["general-purpose", "bash"],
    tool_call_id: Annotated[str, InjectedToolCallId],
    max_turns: int | None = None,
) -> str:
```

关键参数说明：

- `description`：3-5 个词的简短描述，用于日志和前端展示。
- `prompt`：传递给子代理的详细任务描述。
- `subagent_type`：子代理类型，`general-purpose` 用于复杂多步骤任务，`bash` 专注于命令执行。

工具的执行流程是**异步轮询**模式：创建 `SubagentExecutor` 后在后台线程池中启动任务，然后每 5 秒轮询一次任务状态，通过 `get_stream_writer()` 实时向前端推送 `task_started`、`task_running`、`task_completed` 等事件：

```python
executor = SubagentExecutor(config=config, tools=tools, ...)
task_id = executor.execute_async(prompt, task_id=tool_call_id)

writer = get_stream_writer()
writer({"type": "task_started", "task_id": task_id, "description": description})

while True:
    result = get_background_task_result(task_id)
    if result.status == SubagentStatus.COMPLETED:
        writer({"type": "task_completed", ...})
        return f"Task Succeeded. Result: {result.result}"
    time.sleep(5)
```

### 16.2.2 ask_clarification — 向用户提问

当代理遇到信息不足、需求模糊或高风险操作时，使用 `ask_clarification` 工具中断执行并向用户提问：

```python
@tool("ask_clarification", parse_docstring=True, return_direct=True)
def ask_clarification_tool(
    question: str,
    clarification_type: Literal[
        "missing_info", "ambiguous_requirement",
        "approach_choice", "risk_confirmation", "suggestion",
    ],
    context: str | None = None,
    options: list[str] | None = None,
) -> str:
```

注意 `return_direct=True` 标记——这意味着工具的返回值直接作为代理的最终输出，执行流程被中断。实际的中断逻辑由 `ClarificationMiddleware` 拦截处理，工具本身只是一个占位实现。五种 `clarification_type` 覆盖了常见的交互场景：缺少信息、需求歧义、方案选择、风险确认和建议确认。

### 16.2.3 present_files — 文件呈现

代理生成文件后，通过 `present_files` 工具将文件路径注入到会话状态中，前端根据 `artifacts` 列表渲染文件预览：

```python
@tool("present_files", parse_docstring=True)
def present_file_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    filepaths: list[str],
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command:
    normalized_paths = [
        _normalize_presented_filepath(runtime, fp) for fp in filepaths
    ]
    return Command(
        update={
            "artifacts": normalized_paths,
            "messages": [ToolMessage("Successfully presented files", ...)],
        },
    )
```

该工具只接受 `/mnt/user-data/outputs` 目录下的文件路径，通过 `_normalize_presented_filepath` 函数在虚拟路径和主机路径之间做归一化转换，确保沙箱安全。

### 16.2.4 view_image — 图片查看

`view_image` 工具读取图片文件并转为 Base64 编码注入到会话状态中，使多模态模型能够"看到"图片内容：

```python
@tool("view_image", parse_docstring=True)
def view_image_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    image_path: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command:
    # 读取图片并 base64 编码
    with open(actual_path, "rb") as f:
        image_base64 = base64.b64encode(f.read()).decode("utf-8")

    return Command(
        update={
            "viewed_images": {image_path: {"base64": image_base64, "mime_type": mime_type}},
            ...
        },
    )
```

支持 jpg、jpeg、png、webp 四种格式。该工具仅当模型声明支持视觉能力时才被注入。

### 16.2.5 setup_agent — 创建自定义代理

`setup_agent` 工具在 Agent Creator 流程中使用，负责将代理的 SOUL.md 和配置写入磁盘：

```python
@tool
def setup_agent(soul: str, description: str, runtime: ToolRuntime) -> Command:
    agent_dir = paths.agent_dir(agent_name)
    agent_dir.mkdir(parents=True, exist_ok=True)
    # 写入 config.yaml 和 SOUL.md
    soul_file = agent_dir / "SOUL.md"
    soul_file.write_text(soul, encoding="utf-8")
```

## 16.3 社区工具

社区工具位于 `backend/src/community/` 目录下，按功能模块组织，通过 `config.yaml` 中的工具声明动态加载。

### 16.3.1 Tavily — 搜索与抓取

Tavily 模块提供两个工具：

```python
@tool("web_search", parse_docstring=True)
def web_search_tool(query: str) -> str:
    client = _get_tavily_client()
    res = client.search(query, max_results=max_results)
    # 返回 title、url、snippet 的 JSON 列表

@tool("web_fetch", parse_docstring=True)
def web_fetch_tool(url: str) -> str:
    client = _get_tavily_client()
    res = client.extract([url])
    return f"# {result['title']}\n\n{result['raw_content'][:4096]}"
```

`web_search` 返回搜索结果摘要，`web_fetch` 抓取指定 URL 的全文内容（截断到 4096 字符）。API Key 从 `config.yaml` 的工具配置中读取。

### 16.3.2 Jina AI — 网页抓取

Jina 模块提供替代的 `web_fetch` 实现，使用 Jina 的爬虫 API 并通过 `ReadabilityExtractor` 提取正文：

```python
@tool("web_fetch", parse_docstring=True)
def web_fetch_tool(url: str) -> str:
    jina_client = JinaClient()
    html_content = jina_client.crawl(url, return_format="html", timeout=timeout)
    article = readability_extractor.extract_article(html_content)
    return article.to_markdown()[:4096]
```

### 16.3.3 图片搜索

`image_search` 工具基于 DuckDuckGo 的图片搜索 API，用于在图片生成之前找到参考图片：

```python
@tool("image_search", parse_docstring=True)
def image_search_tool(
    query: str,
    max_results: int = 5,
    size: str | None = None,
    type_image: str | None = None,
    layout: str | None = None,
) -> str:
    results = _search_images(query=query, max_results=max_results, ...)
    # 返回包含 image_url、thumbnail_url 的 JSON
```

支持按尺寸、类型（photo/clipart/gif）、布局（Square/Tall/Wide）过滤搜索结果。

### 16.3.4 其他社区模块

`community/` 目录下还包含：

- **firecrawl**：另一个网页抓取方案，基于 Firecrawl 服务。
- **infoquest**：信息查询工具。
- **aio_sandbox**：异步沙箱集成工具。

这些模块通过在 `config.yaml` 中声明 `use: src.community.xxx.tools:xxx_tool` 即可按需启用，无需修改框架代码。

## 小结

DeerFlow 的工具体系设计体现了清晰的层次感：内置工具（task、ask_clarification、present_files、view_image、setup_agent）构成了代理交互的基础能力；社区工具（Tavily、Jina、图片搜索等）提供了联网搜索、内容抓取等实用功能；而 `get_available_tools` 函数作为统一入口，根据模型能力、运行模式和配置文件动态组装工具列表。这种"配置驱动+反射加载"的架构让工具的增删改变得极为简单——只需在 `config.yaml` 中增减一行声明，无需触碰核心代码。
