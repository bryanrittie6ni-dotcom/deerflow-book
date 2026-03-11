# 附录 B　配置字段速查表

本附录列出 DeerFlow `config.yaml` 中所有可用配置字段及其类型、默认值与说明。

## B.1 models（模型列表）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | `str` | 是 | - | 模型唯一标识符 |
| `display_name` | `str \| null` | 否 | `null` | 前端展示名称 |
| `description` | `str \| null` | 否 | `null` | 模型描述信息 |
| `use` | `str` | 是 | - | 类路径，如 `langchain_openai:ChatOpenAI` |
| `model` | `str` | 是 | - | 模型名称，如 `gpt-4` |
| `supports_thinking` | `bool` | 否 | `false` | 是否支持思考/推理模式 |
| `supports_vision` | `bool` | 否 | `false` | 是否支持图像输入 |
| `supports_reasoning_effort` | `bool` | 否 | `false` | 是否支持推理力度调节 |
| `when_thinking_enabled` | `dict \| null` | 否 | `null` | 思考模式启用时传入的额外参数 |
| `thinking` | `dict \| null` | 否 | `null` | thinking 快捷配置，会合并到 `when_thinking_enabled` |
| `api_key` | `str` | 否 | - | API 密钥（支持 `$ENV_VAR` 语法） |
| `api_base` / `base_url` | `str` | 否 | - | 自定义 API 端点 |
| `max_tokens` | `int` | 否 | - | 最大输出 Token 数 |
| `temperature` | `float` | 否 | - | 采样温度 |
| *(其他)* | `Any` | 否 | - | `extra="allow"`，任意额外参数直接透传给模型类 |

## B.2 tools（工具列表）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | `str` | 是 | - | 工具唯一名称 |
| `group` | `str` | 是 | - | 所属分组（`web`、`file:read`、`file:write`、`bash`） |
| `use` | `str` | 是 | - | 变量路径，如 `src.community.tavily.tools:web_search_tool` |
| *(其他)* | `Any` | 否 | - | 工具特有参数（如 `max_results`、`timeout`） |

## B.3 tool_groups（工具分组）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | `str` | 是 | - | 分组名称 |

## B.4 sandbox（沙箱配置）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `use` | `str` | 是 | - | Provider 类路径 |
| `image` | `str \| null` | 否 | AIO 默认镜像 | 沙箱容器镜像 |
| `port` | `int \| null` | 否 | `8080` | 基础端口 |
| `replicas` | `int \| null` | 否 | `3` | 最大并发容器数（LRU 淘汰） |
| `container_prefix` | `str \| null` | 否 | `deer-flow-sandbox` | 容器名前缀 |
| `idle_timeout` | `int \| null` | 否 | `600` | 空闲超时（秒），0 为禁用 |
| `mounts` | `list[VolumeMountConfig]` | 否 | `[]` | 挂载卷列表 |
| `mounts[].host_path` | `str` | 是 | - | 宿主机路径 |
| `mounts[].container_path` | `str` | 是 | - | 容器内路径 |
| `mounts[].read_only` | `bool` | 否 | `false` | 是否只读 |
| `environment` | `dict[str, str]` | 否 | `{}` | 注入容器的环境变量 |
| `provisioner_url` | `str` | 否 | - | Provisioner 服务地址（K8s 模式） |

## B.5 skills（技能配置）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `path` | `str \| null` | 否 | `../skills` | 技能目录路径 |
| `container_path` | `str` | 否 | `/mnt/skills` | 容器内技能挂载路径 |

## B.6 title（标题生成）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `enabled` | `bool` | 否 | `true` | 是否启用自动标题生成 |
| `max_words` | `int` | 否 | `6` | 标题最大词数 |
| `max_chars` | `int` | 否 | `60` | 标题最大字符数 |
| `model_name` | `str \| null` | 否 | `null` | 使用的模型（null 为默认模型） |

## B.7 summarization（对话摘要）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `enabled` | `bool` | 否 | `true` | 是否启用自动摘要 |
| `model_name` | `str \| null` | 否 | `null` | 摘要模型 |
| `trigger` | `list` | 否 | - | 触发条件列表（OR 逻辑） |
| `trigger[].type` | `str` | 是 | - | `tokens` \| `messages` \| `fraction` |
| `trigger[].value` | `number` | 是 | - | 触发阈值 |
| `keep.type` | `str` | 是 | - | 保留策略类型 |
| `keep.value` | `number` | 是 | - | 保留数量 |
| `trim_tokens_to_summarize` | `int \| null` | 否 | `15564` | 摘要前最大 Token 数 |
| `summary_prompt` | `str \| null` | 否 | `null` | 自定义摘要提示词 |

## B.8 memory（全局记忆）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `enabled` | `bool` | 否 | `true` | 是否启用全局记忆 |
| `storage_path` | `str` | 否 | `memory.json` | 存储文件路径 |
| `debounce_seconds` | `int` | 否 | `30` | 更新防抖等待时间 |
| `model_name` | `str \| null` | 否 | `null` | 记忆提取模型 |
| `max_facts` | `int` | 否 | `100` | 最大存储事实数 |
| `fact_confidence_threshold` | `float` | 否 | `0.7` | 事实存储最低置信度 |
| `injection_enabled` | `bool` | 否 | `true` | 是否注入记忆到系统提示词 |
| `max_injection_tokens` | `int` | 否 | `2000` | 记忆注入最大 Token 数 |

## B.9 checkpointer（状态持久化）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `type` | `str` | 是 | `memory` | `memory` \| `sqlite` \| `postgres` |
| `connection_string` | `str \| null` | 否 | `null` | 连接字符串（sqlite 文件路径 / postgres DSN） |

## B.10 subagents（子 Agent 配置）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `timeout_seconds` | `int` | 否 | `900` | 全局默认超时（秒） |
| `agents.<name>.timeout_seconds` | `int` | 否 | 继承全局 | 单个 Agent 超时覆盖 |

## B.11 channels（IM 渠道）

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `langgraph_url` | `str` | 否 | `http://localhost:2024` | LangGraph 服务地址 |
| `gateway_url` | `str` | 否 | `http://localhost:8001` | Gateway API 地址 |
| `session.assistant_id` | `str` | 否 | `lead_agent` | 默认 Assistant ID |
| `feishu.enabled` | `bool` | 否 | `false` | 飞书渠道开关 |
| `feishu.app_id` | `str` | 否 | - | 飞书应用 ID |
| `feishu.app_secret` | `str` | 否 | - | 飞书应用密钥 |
| `slack.enabled` | `bool` | 否 | `false` | Slack 渠道开关 |
| `slack.bot_token` | `str` | 否 | - | Slack Bot Token |
| `slack.app_token` | `str` | 否 | - | Slack App Token（Socket Mode） |
| `telegram.enabled` | `bool` | 否 | `false` | Telegram 渠道开关 |
| `telegram.bot_token` | `str` | 否 | - | Telegram Bot Token |

## B.12 extensions_config.json

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `mcpServers.<name>.enabled` | `bool` | 否 | `true` | MCP 服务器启用开关 |
| `mcpServers.<name>.type` | `str` | 否 | `stdio` | 传输类型：`stdio` \| `sse` \| `http` |
| `mcpServers.<name>.command` | `str` | 否 | - | 启动命令（stdio 类型） |
| `mcpServers.<name>.args` | `list[str]` | 否 | `[]` | 命令参数 |
| `mcpServers.<name>.env` | `dict` | 否 | `{}` | 环境变量 |
| `mcpServers.<name>.url` | `str` | 否 | - | 服务地址（sse/http 类型） |
| `mcpServers.<name>.headers` | `dict` | 否 | `{}` | HTTP 请求头 |
| `mcpServers.<name>.oauth` | `object` | 否 | `null` | OAuth 认证配置 |
| `skills.<name>.enabled` | `bool` | 否 | `true` | 技能启用开关 |

## B.13 环境变量速查

| 环境变量 | 说明 |
|----------|------|
| `DEER_FLOW_CONFIG_PATH` | 自定义 `config.yaml` 路径 |
| `DEER_FLOW_EXTENSIONS_CONFIG_PATH` | 自定义 `extensions_config.json` 路径 |
| `LANGSMITH_TRACING` | 启用 LangSmith 追踪（`true`/`false`） |
| `LANGSMITH_API_KEY` | LangSmith API 密钥 |
| `LANGSMITH_PROJECT` | LangSmith 项目名（默认 `deer-flow`） |
| `LANGSMITH_ENDPOINT` | LangSmith 端点 |
| `DEER_FLOW_ROOT` | Docker 部署时的项目根目录绝对路径 |
| `DEER_FLOW_HOST_BASE_DIR` | 宿主机工作目录 |
| `DEER_FLOW_SANDBOX_HOST` | 沙箱主机地址 |
