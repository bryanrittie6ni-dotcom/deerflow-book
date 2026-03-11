# 第 16 章　MCP 扩展：无限工具

Model Context Protocol（MCP）是 Anthropic 提出的开放协议，为 AI 代理提供了统一的工具调用接口。DeerFlow 深度集成了 MCP，使得用户只需编写一份 JSON 配置文件，即可将任意 MCP 服务器的工具注入到代理的工具列表中。本章将从协议传输、配置格式、客户端实现和 OAuth 认证四个维度深入分析。

## 16.1 三种传输方式

DeerFlow 的 MCP 客户端支持三种传输协议，在 `mcp/client.py` 的 `build_server_params` 函数中实现分发：

```python
def build_server_params(server_name: str, config: McpServerConfig) -> dict[str, Any]:
    transport_type = config.type or "stdio"
    params: dict[str, Any] = {"transport": transport_type}

    if transport_type == "stdio":
        params["command"] = config.command
        params["args"] = config.args
        if config.env:
            params["env"] = config.env
    elif transport_type in ("sse", "http"):
        params["url"] = config.url
        if config.headers:
            params["headers"] = config.headers
    else:
        raise ValueError(f"Unsupported transport type: {transport_type}")

    return params
```

三种传输方式的适用场景：

| 传输方式 | 通信机制 | 适用场景 |
|---------|---------|---------|
| **stdio** | 子进程 stdin/stdout | 本地工具，如文件系统、数据库 CLI |
| **sse** | HTTP Server-Sent Events | 远程服务，需要服务端推送 |
| **http** | HTTP 请求/响应 | 远程无状态 API |

`stdio` 模式最为常用——DeerFlow 会启动一个子进程运行 MCP 服务器，通过标准输入输出通信。`sse` 和 `http` 模式则用于连接远程 MCP 服务器，支持自定义 HTTP 头和 OAuth 认证。

## 16.2 extensions_config.json 配置格式

MCP 服务器的配置文件是 `extensions_config.json`，与 Claude Desktop 的 MCP 配置格式兼容。以下是示例配置：

```json
{
  "mcpServers": {
    "filesystem": {
      "enabled": false,
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/allowed/files"
      ],
      "env": {},
      "description": "Provides filesystem access within allowed directories"
    },
    "github": {
      "enabled": false,
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "$GITHUB_TOKEN"
      },
      "description": "GitHub MCP server for repository operations"
    }
  },
  "skills": {}
}
```

配置项由 `ExtensionsConfig` Pydantic 模型定义：

```python
class McpServerConfig(BaseModel):
    enabled: bool = Field(default=True)
    type: str = Field(default="stdio")       # stdio / sse / http
    command: str | None = None               # stdio 模式的启动命令
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    url: str | None = None                   # sse/http 模式的服务 URL
    headers: dict[str, str] = Field(default_factory=dict)
    oauth: McpOAuthConfig | None = None      # OAuth 配置
    description: str = ""
```

### 环境变量解析

配置文件支持 `$ENV_VAR` 语法引用环境变量，由 `resolve_env_variables` 递归解析：

```python
@classmethod
def resolve_env_variables(cls, config: dict[str, Any]) -> dict[str, Any]:
    for key, value in config.items():
        if isinstance(value, str) and value.startswith("$"):
            env_value = os.getenv(value[1:])
            config[key] = env_value if env_value is not None else ""
        elif isinstance(value, dict):
            config[key] = cls.resolve_env_variables(value)
    return config
```

例如 `"GITHUB_TOKEN": "$GITHUB_TOKEN"` 会在加载时自动替换为实际的环境变量值。如果环境变量不存在，会被替换为空字符串，避免将字面量 `$VAR` 泄漏给 MCP 服务器。

### 配置文件查找顺序

`resolve_config_path` 按以下优先级定位配置文件：

1. 显式传入的 `config_path` 参数
2. `DEER_FLOW_EXTENSIONS_CONFIG_PATH` 环境变量
3. 当前目录下的 `extensions_config.json`
4. 父目录下的 `extensions_config.json`
5. 向后兼容的 `mcp_config.json`

## 16.3 工具加载与缓存

### MultiServerMCPClient 初始化

`mcp/tools.py` 中的 `get_mcp_tools` 是实际的工具加载入口，它通过 `langchain-mcp-adapters` 库的 `MultiServerMCPClient` 连接所有已启用的 MCP 服务器：

```python
async def get_mcp_tools() -> list[BaseTool]:
    extensions_config = ExtensionsConfig.from_file()
    servers_config = build_servers_config(extensions_config)

    # 注入 OAuth 头到 SSE/HTTP 连接
    initial_oauth_headers = await get_initial_oauth_headers(extensions_config)
    for server_name, auth_header in initial_oauth_headers.items():
        if servers_config[server_name].get("transport") in ("sse", "http"):
            existing_headers = dict(servers_config[server_name].get("headers", {}))
            existing_headers["Authorization"] = auth_header
            servers_config[server_name]["headers"] = existing_headers

    # 构建 OAuth 拦截器用于运行时 token 刷新
    tool_interceptors = []
    oauth_interceptor = build_oauth_tool_interceptor(extensions_config)
    if oauth_interceptor is not None:
        tool_interceptors.append(oauth_interceptor)

    client = MultiServerMCPClient(servers_config, tool_interceptors=tool_interceptors)
    tools = await client.get_tools()
    return tools
```

### 缓存策略

MCP 工具的初始化开销较大（需要启动子进程或建立网络连接），因此 `mcp/cache.py` 实现了一套完整的缓存机制：

```python
_mcp_tools_cache: list[BaseTool] | None = None
_cache_initialized = False
_initialization_lock = asyncio.Lock()
_config_mtime: float | None = None  # 追踪配置文件修改时间
```

缓存的核心逻辑包含三个关键点：

1. **异步锁保护初始化**——通过 `asyncio.Lock()` 确保多个并发请求不会重复初始化。
2. **文件修改时间检测**——每次获取缓存工具时，检查 `extensions_config.json` 的 `mtime` 是否变化，如有变化则自动失效缓存并重新加载。
3. **跨事件循环兼容**——`get_cached_mcp_tools` 支持在已运行的事件循环中（如 LangGraph Studio）通过 `ThreadPoolExecutor` 在独立线程中完成初始化：

```python
def get_cached_mcp_tools() -> list[BaseTool]:
    if _is_cache_stale():
        reset_mcp_tools_cache()

    if not _cache_initialized:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            with concurrent.futures.ThreadPoolExecutor() as executor:
                future = executor.submit(asyncio.run, initialize_mcp_tools())
                future.result()
        else:
            loop.run_until_complete(initialize_mcp_tools())

    return _mcp_tools_cache or []
```

## 16.4 OAuth 认证

对于需要身份认证的远程 MCP 服务器，DeerFlow 提供了完整的 OAuth token 管理机制。`OAuthTokenManager` 负责 token 的获取、缓存和自动刷新：

```python
class OAuthTokenManager:
    async def get_authorization_header(self, server_name: str) -> str | None:
        token = self._tokens.get(server_name)
        if token and not self._is_expiring(token, oauth):
            return f"{token.token_type} {token.access_token}"

        async with lock:
            fresh = await self._fetch_token(oauth)
            self._tokens[server_name] = fresh
            return f"{fresh.token_type} {fresh.access_token}"
```

支持两种 OAuth 授权类型：

- **client_credentials**：适用于服务间调用，需要 `client_id` 和 `client_secret`。
- **refresh_token**：适用于代表用户操作，使用刷新令牌换取访问令牌。

Token 在过期前 `refresh_skew_seconds`（默认 60 秒）自动刷新，双重检查锁避免并发请求重复刷新。

配置示例：

```json
{
  "mcpServers": {
    "my-api": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "oauth": {
        "enabled": true,
        "token_url": "https://auth.example.com/oauth/token",
        "grant_type": "client_credentials",
        "client_id": "$MY_CLIENT_ID",
        "client_secret": "$MY_CLIENT_SECRET",
        "scope": "tools:read"
      }
    }
  }
}
```

## 16.5 实战：接入 Playwright MCP

下面以 Playwright MCP 服务器为例，演示如何让 DeerFlow 代理获得浏览器操控能力。

**第一步**：安装 Playwright MCP 服务器：

```bash
npm install -g @anthropic/mcp-server-playwright
```

**第二步**：编辑 `extensions_config.json`：

```json
{
  "mcpServers": {
    "playwright": {
      "enabled": true,
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-server-playwright"],
      "description": "Browser automation with Playwright"
    }
  }
}
```

**第三步**：重启 DeerFlow 后端。MCP 工具会在首次请求时自动加载并缓存：

```
INFO - Initializing MCP tools...
INFO - Configured MCP server: playwright
INFO - Successfully loaded 8 tool(s) from MCP servers
INFO - MCP tools initialized: 8 tool(s) loaded
```

此时代理即可使用 `browser_navigate`、`browser_click`、`browser_screenshot` 等工具操控浏览器。

**第四步**：通过 Gateway API 动态管理 MCP 配置。DeerFlow 的 `/api/mcp` 路由支持运行时更新配置，无需重启服务：

```bash
# 查看当前 MCP 配置
curl http://localhost:8001/api/mcp/servers

# 更新配置
curl -X PUT http://localhost:8001/api/mcp/servers \
  -H "Content-Type: application/json" \
  -d '{"playwright": {"enabled": true, ...}}'
```

由于缓存模块会检测配置文件的修改时间，LangGraph Server 进程会自动感知配置变更并重新加载工具。

## 小结

DeerFlow 的 MCP 集成具有三个突出特点：**协议兼容**（支持 stdio/SSE/HTTP 三种传输，与 Claude Desktop 配置格式兼容）、**自动缓存**（基于文件修改时间的智能缓存失效机制，避免重复初始化开销）、**安全认证**（内置 OAuth token 管理，支持 client_credentials 和 refresh_token 两种授权模式）。通过一个 JSON 配置文件，开发者可以将社区中数百个 MCP 服务器的工具无缝集成到 DeerFlow 代理中，真正实现了"无限工具"的愿景。
