# 第 18 章　FastAPI Gateway

DeerFlow 的 HTTP 服务层由两部分组成：LangGraph Server 负责代理执行和流式对话，FastAPI Gateway 则提供模型管理、MCP 配置、技能管理、文件上传等辅助 API。两者通过 Nginx 反向代理统一对外暴露。本章聚焦 FastAPI Gateway 的架构设计与实现细节。

## 18.1 应用启动流程

Gateway 的入口文件是 `gateway/app.py`，通过 `create_app` 工厂函数创建 FastAPI 实例：

```python
def create_app() -> FastAPI:
    app = FastAPI(
        title="DeerFlow API Gateway",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
    )

    # 注册 9 个路由模块
    app.include_router(models.router)      # /api/models
    app.include_router(mcp.router)         # /api/mcp
    app.include_router(memory.router)      # /api/memory
    app.include_router(skills.router)      # /api/skills
    app.include_router(artifacts.router)   # /api/threads/{thread_id}/artifacts
    app.include_router(uploads.router)     # /api/threads/{thread_id}/uploads
    app.include_router(agents.router)      # /api/agents
    app.include_router(suggestions.router) # /api/threads/{thread_id}/suggestions
    app.include_router(channels.router)    # /api/channels

    @app.get("/health", tags=["health"])
    async def health_check() -> dict:
        return {"status": "healthy", "service": "deer-flow-gateway"}

    return app

app = create_app()
```

### Lifespan 生命周期

FastAPI 的 `lifespan` 上下文管理器控制应用的启停逻辑：

```python
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    # 启动阶段：加载配置
    get_app_config()
    config = get_gateway_config()
    logger.info(f"Starting API Gateway on {config.host}:{config.port}")

    # 启动 IM 渠道服务
    try:
        from src.channels.service import start_channel_service
        channel_service = await start_channel_service()
    except Exception:
        logger.exception("No IM channels configured or channel service failed to start")

    yield  # 应用运行中

    # 关闭阶段：停止渠道服务
    from src.channels.service import stop_channel_service
    await stop_channel_service()
    logger.info("Shutting down API Gateway")
```

有两个重要的设计决策值得关注：

1. **MCP 工具不在 Gateway 中初始化**——注释明确说明 Gateway 和 LangGraph Server 是独立进程，MCP 工具由 LangGraph Server 延迟初始化。
2. **IM 渠道服务在 Gateway 启动时启动**——Telegram、Slack、飞书等渠道的长连接在此建立。

### CORS 处理

源码中有一行关键注释：`# CORS is handled by nginx - no need for FastAPI middleware`。DeerFlow 将 CORS 策略交由 Nginx 反向代理统一管理，避免了 FastAPI 层面的 CORS 配置。

## 18.2 九大 Router 模块

Gateway 按功能拆分为 9 个 Router 模块，每个模块职责单一：

| Router | 路由前缀 | 职责 |
|--------|---------|------|
| **models** | `/api/models` | 查询可用 AI 模型及其配置 |
| **mcp** | `/api/mcp` | 管理 MCP 服务器配置 |
| **memory** | `/api/memory` | 全局记忆数据的读写 |
| **skills** | `/api/skills` | 技能的查询、启停和安装 |
| **artifacts** | `/api/threads/{id}/artifacts` | 访问线程生成的文件产物 |
| **uploads** | `/api/threads/{id}/uploads` | 文件上传与管理 |
| **agents** | `/api/agents` | 自定义代理的 CRUD |
| **suggestions** | `/api/threads/{id}/suggestions` | 生成后续问题建议 |
| **channels** | `/api/channels` | IM 渠道状态查询与重启 |

### 18.2.1 Agents Router — 自定义代理管理

`agents.py` 提供了完整的代理 CRUD API：

```python
router = APIRouter(prefix="/api", tags=["agents"])

@router.get("/agents")
async def list_agents() -> AgentsListResponse:
    agents = list_custom_agents()
    return AgentsListResponse(agents=[...])

@router.post("/agents", status_code=201)
async def create_agent_endpoint(request: AgentCreateRequest) -> AgentResponse:
    # 验证名称（只允许字母、数字、连字符）
    _validate_agent_name(request.name)
    normalized_name = _normalize_agent_name(request.name)

    agent_dir = get_paths().agent_dir(normalized_name)
    agent_dir.mkdir(parents=True, exist_ok=True)

    # 写入 config.yaml 和 SOUL.md
    config_file = agent_dir / "config.yaml"
    with open(config_file, "w", encoding="utf-8") as f:
        yaml.dump(config_data, f, ...)

    soul_file = agent_dir / "SOUL.md"
    soul_file.write_text(request.soul, encoding="utf-8")
```

名称校验使用正则 `^[A-Za-z0-9-]+$`，存储时统一转为小写。创建失败时会自动清理已创建的目录，保证原子性。

此外还提供了 `/api/user-profile` 端点用于管理全局 USER.md 文件，该文件的内容会被注入到所有自定义代理的系统提示词中。

### 18.2.2 Uploads Router — 文件上传

文件上传路由支持批量上传，并对 Office 文档自动转换为 Markdown：

```python
router = APIRouter(prefix="/api/threads/{thread_id}/uploads", tags=["uploads"])

CONVERTIBLE_EXTENSIONS = {".pdf", ".ppt", ".pptx", ".xls", ".xlsx", ".doc", ".docx"}

@router.post("", response_model=UploadResponse)
async def upload_files(
    thread_id: str,
    files: list[UploadFile] = File(...),
) -> UploadResponse:
    for file in files:
        # 安全文件名处理，防止路径穿越
        safe_filename = Path(file.filename).name

        content = await file.read()
        file_path = uploads_dir / safe_filename
        file_path.write_bytes(content)

        # 非本地沙箱同步文件到虚拟路径
        if sandbox_id != "local":
            sandbox.update_file(virtual_path, content)

        # 自动转换 Office 文件为 Markdown
        if file_ext in CONVERTIBLE_EXTENSIONS:
            md_path = await convert_file_to_markdown(file_path)
```

文件转换使用 `markitdown` 库，支持 PDF、PPT、Excel、Word 等格式。转换后的 Markdown 文件与原文件一起保存，代理可以直接读取 Markdown 内容进行分析。

每个上传文件的响应包含三种路径：
- `path`：主机文件系统的实际路径
- `virtual_path`：沙箱内的虚拟路径（`/mnt/user-data/uploads/...`）
- `artifact_url`：HTTP 访问 URL

### 18.2.3 Skills Router — 技能管理

技能管理路由提供了查询、启停和安装功能：

```python
@router.put("/skills/{skill_name}")
async def update_skill(skill_name: str, request: SkillUpdateRequest) -> SkillResponse:
    # 更新 extensions_config.json 中的技能状态
    extensions_config.skills[skill_name] = SkillStateConfig(enabled=request.enabled)

    # 写入配置文件
    with open(config_path, "w") as f:
        json.dump(config_data, f, indent=2)

    # 重新加载配置缓存
    reload_extensions_config()

@router.post("/skills/install")
async def install_skill(request: SkillInstallRequest) -> SkillInstallResponse:
    # 从 .skill 文件（ZIP 压缩包）安装技能
    # 验证 SKILL.md frontmatter 格式
    # 解压到 custom skills 目录
```

技能的启停状态持久化在 `extensions_config.json` 的 `skills` 字段中，与 MCP 配置共享同一个配置文件。

### 18.2.4 Channels Router — 渠道管理

渠道路由提供了状态查询和重启功能：

```python
router = APIRouter(prefix="/api/channels", tags=["channels"])

@router.get("/", response_model=ChannelStatusResponse)
async def get_channels_status() -> ChannelStatusResponse:
    service = get_channel_service()
    if service is None:
        return ChannelStatusResponse(service_running=False, channels={})
    return ChannelStatusResponse(**service.get_status())

@router.post("/{name}/restart", response_model=ChannelRestartResponse)
async def restart_channel(name: str) -> ChannelRestartResponse:
    service = get_channel_service()
    success = await service.restart_channel(name)
    return ChannelRestartResponse(success=success, ...)
```

## 18.3 OpenAPI 文档

Gateway 内置了完善的 OpenAPI 文档，通过 `/docs`（Swagger UI）和 `/redoc` 访问。每个路由组都配有标签描述：

```python
openapi_tags=[
    {"name": "models", "description": "Operations for querying available AI models..."},
    {"name": "mcp", "description": "Manage Model Context Protocol configurations"},
    {"name": "skills", "description": "Manage skills and their configurations"},
    {"name": "artifacts", "description": "Access and download thread artifacts"},
    {"name": "uploads", "description": "Upload and manage user files"},
    {"name": "agents", "description": "Create and manage custom agents"},
    {"name": "channels", "description": "Manage IM channel integrations"},
    {"name": "health", "description": "Health check and system status endpoints"},
]
```

所有 API 端点都使用 Pydantic 模型定义请求和响应格式，确保类型安全和文档自动生成。

## 18.4 架构全景

Gateway 在 DeerFlow 整体架构中的位置如下：

```
客户端 (Web/CLI)
    │
    ▼
  Nginx 反向代理
    ├── /api/*  ──→  FastAPI Gateway (:8001)
    │                  ├── models / mcp / memory
    │                  ├── skills / artifacts / uploads
    │                  ├── agents / suggestions / channels
    │                  └── IM Channel Service (Telegram/Slack/Feishu)
    └── /threads/* ──→ LangGraph Server (:2024)
                        ├── Agent 执行
                        └── SSE 流式响应
```

Gateway 和 LangGraph Server 运行在独立进程中，通过共享配置文件（`extensions_config.json`）和磁盘存储（线程数据目录）间接通信。这种分离确保了管理 API 的变更不会影响代理执行的稳定性。

## 小结

FastAPI Gateway 是 DeerFlow 的管理中枢，承担着模型配置、工具管理、文件处理和渠道运维等辅助职责。9 个 Router 模块按功能解耦，每个模块自包含路由、请求/响应模型和业务逻辑。Gateway 与 LangGraph Server 的进程隔离设计是一个值得学习的架构模式——管理面和数据面分离，既保证了管理操作的灵活性，又避免了对代理执行链路的干扰。
