# 第 20 章　配置体系全解

DeerFlow 的配置体系由三层文件组成：`config.yaml` 负责核心应用设置，`extensions_config.json` 管理 MCP 服务器与技能状态，`.env` 文件提供敏感凭据。三者职责分明、互相配合，共同构成了一套灵活而安全的配置架构。

## 20.1 配置加载流程

应用启动时，`AppConfig.from_file()` 按如下优先级定位 `config.yaml`：

1. 显式传入的 `config_path` 参数；
2. 环境变量 `DEER_FLOW_CONFIG_PATH` 指向的路径；
3. 当前工作目录下的 `config.yaml`，不存在则回退到父目录。

```python
# backend/src/config/app_config.py
@classmethod
def resolve_config_path(cls, config_path: str | None = None) -> Path:
    if config_path:
        path = Path(config_path)
        if not Path.exists(path):
            raise FileNotFoundError(...)
        return path
    elif os.getenv("DEER_FLOW_CONFIG_PATH"):
        path = Path(os.getenv("DEER_FLOW_CONFIG_PATH"))
        ...
    else:
        path = Path(os.getcwd()) / "config.yaml"
        if not path.exists():
            path = Path(os.getcwd()).parent / "config.yaml"
        ...
```

加载 YAML 后，系统依次解析 `title`、`summarization`、`memory`、`subagents`、`checkpointer` 等子配置，然后独立加载 `ExtensionsConfig`，最终通过 Pydantic 的 `model_validate` 完成校验。

配置采用**单例缓存**模式：

```python
_app_config: AppConfig | None = None

def get_app_config() -> AppConfig:
    global _app_config
    if _app_config is None:
        _app_config = AppConfig.from_file()
    return _app_config
```

运行时可通过 `reload_app_config()` 热重载，或通过 `set_app_config()` 注入测试替身。

## 20.2 环境变量注入：$VAR_NAME 语法

DeerFlow 支持在 YAML 值中使用 `$` 前缀引用环境变量。`resolve_env_variables` 方法递归遍历整棵配置树，将所有以 `$` 开头的字符串替换为对应的环境变量值：

```python
@classmethod
def resolve_env_variables(cls, config: Any) -> Any:
    if isinstance(config, str):
        if config.startswith("$"):
            env_value = os.getenv(config[1:])
            if env_value is None:
                raise ValueError(
                    f"Environment variable {config[1:]} not found ..."
                )
            return env_value
        return config
    elif isinstance(config, dict):
        return {k: cls.resolve_env_variables(v) for k, v in config.items()}
    elif isinstance(config, list):
        return [cls.resolve_env_variables(item) for item in config]
    return config
```

在 `config.yaml` 中的实际写法：

```yaml
models:
  - name: gpt-4
    use: langchain_openai:ChatOpenAI
    model: gpt-4
    api_key: $OPENAI_API_KEY   # 运行时从环境变量读取
```

注意：`config.yaml` 中的环境变量如果找不到会直接抛出异常；而 `extensions_config.json` 中找不到环境变量时，会静默替换为空字符串——两者行为有差异，这是设计上的考量。

## 20.3 config.yaml 全字段速查

`config.yaml` 的顶层结构对应 `AppConfig` 的字段：

```yaml
models:          # 模型列表，详见第 21 章
tool_groups:     # 工具分组（web, file:read, file:write, bash）
tools:           # 工具配置，每个工具指定 name/group/use 及额外参数
sandbox:         # 沙箱配置（use 字段指定 Provider 类）
skills:          # 技能目录配置（path, container_path）
title:           # 标题生成（enabled, max_words, max_chars, model_name）
summarization:   # 对话摘要（trigger, keep, trim_tokens_to_summarize）
memory:          # 全局记忆（storage_path, max_facts, injection_enabled）
checkpointer:    # 状态持久化（type: memory|sqlite|postgres）
subagents:       # 子 Agent 超时配置
channels:        # IM 渠道集成（feishu, slack, telegram）
```

工具配置的基本结构：

```yaml
tools:
  - name: web_search
    group: web
    use: src.community.tavily.tools:web_search_tool
    max_results: 5
```

`use` 字段是 DeerFlow 配置体系的核心机制——它是一个 Python 类/变量路径，格式为 `module.path:ClassName`。系统通过 `resolve_class` 或 `resolve_variable` 在运行时动态导入。

## 20.4 extensions_config.json：MCP 服务器与技能状态

`extensions_config.json` 是独立于 `config.yaml` 的 JSON 文件，管理两类扩展：

```json
{
  "mcpServers": {
    "github": {
      "enabled": true,
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "$GITHUB_TOKEN"
      },
      "description": "GitHub MCP server"
    }
  },
  "skills": {
    "my_custom_skill": {
      "enabled": false
    }
  }
}
```

文件定位逻辑与 `config.yaml` 类似，优先级为：

1. 参数传入；
2. 环境变量 `DEER_FLOW_EXTENSIONS_CONFIG_PATH`；
3. 当前目录或父目录的 `extensions_config.json`；
4. 向后兼容：查找旧文件名 `mcp_config.json`。

MCP 服务器支持三种传输类型：`stdio`（启动子进程）、`sse`（Server-Sent Events）和 `http`。对于 `sse`/`http` 类型，还可以配置 OAuth 认证：

```python
class McpServerConfig(BaseModel):
    enabled: bool = Field(default=True)
    type: str = Field(default="stdio")       # stdio | sse | http
    command: str | None = None               # stdio 专用
    args: list[str] = Field(default_factory=list)
    url: str | None = None                   # sse/http 专用
    headers: dict[str, str] = Field(default_factory=dict)
    oauth: McpOAuthConfig | None = None      # OAuth 令牌注入
```

运行时获取已启用的 MCP 服务器：

```python
config = get_extensions_config()
enabled_servers = config.get_enabled_mcp_servers()
```

## 20.5 skills_state_config

在 `extensions_config.json` 的 `skills` 字段中，可以控制各技能的启用状态。默认情况下，`public` 和 `custom` 类别的技能自动启用，只有在显式配置 `"enabled": false` 时才会禁用：

```python
def is_skill_enabled(self, skill_name: str, skill_category: str) -> bool:
    skill_config = self.skills.get(skill_name)
    if skill_config is None:
        return skill_category in ("public", "custom")
    return skill_config.enabled
```

## 20.6 Checkpointer 持久化配置

DeerFlow 支持三种 Checkpointer 后端来持久化 LangGraph 的对话状态：

```yaml
# 内存模式（默认，进程退出即丢失）
checkpointer:
  type: memory

# SQLite 模式（本地文件持久化）
checkpointer:
  type: sqlite
  connection_string: checkpoints.db

# PostgreSQL 模式（多进程/生产部署）
checkpointer:
  type: postgres
  connection_string: postgresql://user:password@localhost:5432/deerflow
```

使用 SQLite 或 PostgreSQL 需要额外安装对应依赖包。

## 小结

DeerFlow 的配置体系遵循"约定优于配置"的原则：`config.yaml` 统管应用核心设置，`extensions_config.json` 独立管理扩展生态，环境变量通过 `$VAR` 语法安全注入敏感信息。所有配置均基于 Pydantic 模型进行校验，确保类型安全。`use` 字段的动态加载机制贯穿了模型、工具和沙箱三大子系统，是理解 DeerFlow 可扩展架构的关键。下一章我们将深入模型配置与适配的细节。
