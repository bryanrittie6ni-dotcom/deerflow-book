# 第 23 章　部署与生产化

从开发环境到生产部署，DeerFlow 提供了完整的 Docker Compose 编排方案、Nginx 反向代理配置和可观测性集成。本章覆盖部署的各个环节，帮助你将 DeerFlow 安全、稳定地运行在生产环境中。

## 23.1 Docker Compose 完整部署

DeerFlow 的 Docker 开发环境由 `docker/docker-compose-dev.yaml` 定义，包含四个核心服务：

```yaml
services:
  nginx:        # 反向代理，端口 2026
  frontend:     # Next.js 前端，端口 3000
  gateway:      # FastAPI 网关，端口 8001
  langgraph:    # LangGraph 服务器，端口 2024
  provisioner:  # 可选：沙箱编排器，端口 8002
```

后端使用统一的 Dockerfile 构建：

```dockerfile
# backend/Dockerfile
FROM python:3.12-slim

RUN apt-get update && apt-get install -y curl build-essential \
    && rm -rf /var/lib/apt/lists/*

# 安装 Docker CLI（Docker-outside-of-Docker 模式）
COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker

# 安装 uv 包管理器
COPY --from=ghcr.io/astral-sh/uv:0.7.20 /uv /uvx /usr/local/bin/

WORKDIR /app
COPY backend ./backend

# 利用 cache mount 加速依赖安装
RUN --mount=type=cache,target=/root/.cache/uv \
    sh -c "cd backend && uv sync"

EXPOSE 8001 2024
```

Gateway 和 LangGraph 共享同一镜像，通过不同的启动命令区分：

```yaml
# Gateway 服务
gateway:
  command: >
    sh -c "cd backend && uv run uvicorn src.gateway.app:app
    --host 0.0.0.0 --port 8001 --reload --reload-include='*.yaml .env'"

# LangGraph 服务
langgraph:
  command: >
    sh -c "cd backend && uv run langgraph dev
    --no-browser --allow-blocking --host 0.0.0.0 --port 2024"
```

两个服务各自拥有独立的 `.venv` volume（`gateway-venv` 和 `langgraph-venv`），避免宿主机挂载覆盖容器内构建好的虚拟环境。

使用 Makefile 快速操作：

```bash
make docker-start    # 启动所有服务
make docker-stop     # 停止服务
make docker-logs     # 查看日志
```

## 23.2 环境变量安全管理

DeerFlow 的敏感信息管理遵循十二因素应用原则：

**`.env` 文件**：项目根目录的 `.env` 文件在 Python 端通过 `load_dotenv()` 加载，在 Docker 中通过 `env_file` 注入：

```yaml
gateway:
  env_file:
    - ../.env
  environment:
    - CI=true
    - DEER_FLOW_HOST_BASE_DIR=${DEER_FLOW_ROOT}/backend/.deer-flow
    - DEER_FLOW_SANDBOX_HOST=host.docker.internal
```

**API Key 不进 YAML**：`config.yaml` 中使用 `$VAR_NAME` 引用，实际值存放在 `.env` 中：

```yaml
# config.yaml
api_key: $OPENAI_API_KEY

# .env
OPENAI_API_KEY=sk-xxxx
```

**生产建议**：
- `.env` 文件必须加入 `.gitignore`；
- 生产环境应使用 Kubernetes Secrets 或云平台的密钥管理服务；
- Docker Compose 中敏感变量可通过 Docker Secrets 注入。

## 23.3 反向代理配置

Nginx 作为统一入口（端口 2026），按路径分发请求：

```nginx
server {
    listen 2026 default_server;

    # LangGraph API（流式传输）
    location /api/langgraph/ {
        rewrite ^/api/langgraph/(.*) /$1 break;
        proxy_pass http://langgraph;
        proxy_buffering off;           # 关键：SSE 流式传输
        proxy_cache off;
        proxy_set_header X-Accel-Buffering no;
        proxy_read_timeout 600s;       # 长请求超时
        chunked_transfer_encoding on;
    }

    # Gateway API 路由
    location /api/models  { proxy_pass http://gateway; ... }
    location /api/memory  { proxy_pass http://gateway; ... }
    location /api/mcp     { proxy_pass http://gateway; ... }
    location /api/skills  { proxy_pass http://gateway; ... }

    # 文件上传（100MB 限制）
    location ~ ^/api/threads/[^/]+/uploads {
        proxy_pass http://gateway;
        client_max_body_size 100M;
        proxy_request_buffering off;
    }

    # 前端静态资源（兜底路由）
    location / {
        proxy_pass http://frontend;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
```

CORS 由 Nginx 统一处理，避免各后端服务重复设置：

```nginx
proxy_hide_header 'Access-Control-Allow-Origin';
add_header 'Access-Control-Allow-Origin' '*' always;
add_header 'Access-Control-Allow-Methods' 'GET, POST, PUT, DELETE, PATCH, OPTIONS' always;
add_header 'Access-Control-Allow-Headers' '*' always;
```

生产环境应将 `*` 替换为具体域名，并启用 HTTPS。

## 23.4 OpenTelemetry 与 LangSmith 追踪

DeerFlow 内置了 LangSmith 追踪集成，通过环境变量配置：

```python
# backend/src/config/tracing_config.py
class TracingConfig(BaseModel):
    enabled: bool       # LANGSMITH_TRACING 或 LANGCHAIN_TRACING_V2
    api_key: str | None # LANGSMITH_API_KEY 或 LANGCHAIN_API_KEY
    project: str        # LANGSMITH_PROJECT，默认 "deer-flow"
    endpoint: str       # LANGSMITH_ENDPOINT
```

在 `.env` 中启用：

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_pt_xxxx
LANGSMITH_PROJECT=deer-flow-prod
```

追踪器会自动附加到每个模型实例的回调链中：

```python
if is_tracing_enabled():
    tracer = LangChainTracer(project_name=tracing_config.project)
    model_instance.callbacks = [*existing_callbacks, tracer]
```

这提供了完整的 LLM 调用链路追踪，包括输入输出、延迟、Token 消耗等指标。

## 23.5 性能调优

**沙箱并发控制**：通过 `replicas` 参数限制并发沙箱容器数量，采用 LRU 淘汰策略：

```yaml
sandbox:
  use: src.community.aio_sandbox:AioSandboxProvider
  replicas: 5            # 最多 5 个并发容器
  idle_timeout: 600      # 空闲 10 分钟自动回收
```

**对话摘要**：长对话通过 `summarization` 配置自动压缩，避免 Token 超限：

```yaml
summarization:
  enabled: true
  trigger:
    - type: tokens
      value: 15564
  keep:
    type: messages
    value: 10
```

**子 Agent 超时**：防止单个任务长时间阻塞：

```yaml
subagents:
  timeout_seconds: 900     # 全局 15 分钟
  agents:
    bash:
      timeout_seconds: 300 # bash 任务 5 分钟
```

**状态持久化**：生产环境推荐使用 PostgreSQL checkpointer 支持多进程部署：

```yaml
checkpointer:
  type: postgres
  connection_string: postgresql://user:pass@localhost:5432/deerflow
```

## 23.6 生产监控

**健康检查**：Gateway 暴露 `/health` 端点，Docker Compose 中可配置：

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8001/health"]
  interval: 10s
  timeout: 5s
  retries: 6
```

**日志管理**：所有服务日志输出到 `logs/` 目录，可对接 ELK 或 Loki：

```yaml
volumes:
  - ../logs:/app/logs
```

**网络隔离**：Docker Compose 使用独立的 bridge 网络，固定子网避免冲突：

```yaml
networks:
  deer-flow-dev:
    driver: bridge
    ipam:
      config:
        - subnet: 192.168.200.0/24
```

**IM 渠道监控**：Slack、飞书、Telegram 等渠道可通过 `channels` 配置接入，所有渠道使用出站连接（WebSocket 或轮询），无需公网 IP。

## 小结

DeerFlow 的部署架构以 Docker Compose 为核心，通过 Nginx 反向代理统一入口，Gateway 和 LangGraph 双服务分工明确。生产化需要关注四个层面：环境变量安全管理（`.env` + `$VAR` 语法）、反向代理的 SSE 流式传输配置、LangSmith 追踪的可观测性，以及沙箱并发与对话摘要的性能调优。可选的 Provisioner 服务进一步支持了 Kubernetes 上的沙箱编排，为大规模部署提供了扩展路径。
