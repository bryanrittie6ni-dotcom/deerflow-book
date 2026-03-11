# 附录 C　术语表

本术语表收录 DeerFlow 项目中的核心概念与技术术语，按英文字母顺序排列。

| 术语 | 说明 |
|------|------|
| **Agent** | 智能体，具备自主决策能力的 LLM 驱动实体。DeerFlow 中的 Agent 能够调用工具、执行代码、生成报告等。 |
| **AIO Sandbox** | All-in-One 沙箱，基于 Docker 或 Apple Container 的隔离执行环境，提供文件系统、Bash 和代码运行能力。 |
| **AppConfig** | 应用配置类，从 `config.yaml` 加载，是 DeerFlow 配置体系的顶层 Pydantic 模型。 |
| **BaseChatModel** | LangChain 定义的聊天模型基类，所有通过 `use` 字段加载的模型类都必须是其子类。 |
| **Channel** | IM 渠道，指飞书、Slack、Telegram 等外部消息平台的集成接口。所有渠道均使用出站连接。 |
| **Checkpointer** | 状态检查点器，LangGraph 的持久化机制，支持 memory、sqlite、postgres 三种后端。 |
| **config.yaml** | DeerFlow 的主配置文件，定义模型、工具、沙箱、摘要、记忆等核心设置。 |
| **create_chat_model** | 模型工厂函数，根据 config.yaml 中的模型名称动态实例化 LangChain 模型。 |
| **DEER_FLOW_CONFIG_PATH** | 环境变量，用于指定 `config.yaml` 的自定义路径。 |
| **Docker-outside-of-Docker (DooD)** | 容器内通过挂载宿主机的 Docker socket 来启动和管理其他容器的技术。 |
| **extensions_config.json** | 扩展配置文件，管理 MCP 服务器和技能状态，独立于 `config.yaml`。 |
| **ExtensionsConfig** | 扩展配置类，解析 `extensions_config.json`，管理 MCP 服务器和技能的启用/禁用状态。 |
| **extra="allow"** | Pydantic ConfigDict 设置，允许模型接受未预先定义的额外字段，实现参数透传。 |
| **Gateway** | 网关服务，基于 FastAPI 构建，提供模型列表、记忆管理、MCP 配置等 REST API。 |
| **Harness** | 工具容器/包装器，将底层工具封装为 Agent 可调用的标准接口。 |
| **LangGraph** | LangChain 的状态图执行框架，DeerFlow 用其编排多 Agent 工作流。 |
| **LangGraph Server** | LangGraph 的独立服务进程，管理线程和消息的持久化与执行。 |
| **LangSmith** | LangChain 的可观测性平台，提供 LLM 调用链追踪、延迟分析和成本监控。 |
| **Lead Agent** | 主 Agent，DeerFlow 的调度中枢，负责任务规划、子任务分配和结果汇总。 |
| **MCP (Model Context Protocol)** | 模型上下文协议，标准化 LLM 与外部工具/服务交互的协议，支持 stdio、SSE、HTTP 传输。 |
| **McpServerConfig** | MCP 服务器配置类，定义单个 MCP 服务器的传输方式、认证和连接参数。 |
| **Memory** | 全局记忆系统，跨会话存储用户偏好和事实信息，通过系统提示词注入实现个性化响应。 |
| **Middleware** | 中间件，在请求处理流程中插入的预处理/后处理逻辑，如认证、日志、CORS 等。 |
| **ModelConfig** | 模型配置类，描述单个 LLM 的名称、类路径、能力标记和构造参数。 |
| **PatchedChatDeepSeek** | DeepSeek 模型的补丁类，修复多轮对话中 `reasoning_content` 字段丢失的问题。 |
| **Provisioner** | 沙箱编排器，在 Kubernetes 集群中为每个沙箱创建独立的 Pod 和 Service。 |
| **reasoning_content** | DeepSeek 思考模式产生的推理过程内容，需要在多轮对话中持续传递。 |
| **resolve_class** | 反射解析函数，将 `module.path:ClassName` 字符串解析为 Python 类对象。 |
| **Sandbox** | 沙箱，代码执行的隔离环境。DeerFlow 支持本地沙箱（直接执行）和容器沙箱（Docker/Apple Container）。 |
| **SandboxConfig** | 沙箱配置类，定义 Provider 类路径、容器镜像、端口、并发数等参数。 |
| **Skill** | 技能，预定义的专业化工作流（如绘图、数据分析），以目录形式组织，包含提示词和依赖配置。 |
| **SkillStateConfig** | 技能状态配置，控制单个技能是否启用，存储在 `extensions_config.json` 的 `skills` 字段中。 |
| **Sub-Agent** | 子 Agent，由 Lead Agent 委派执行具体任务的工作 Agent，如通用研究、Bash 执行等。 |
| **Summarization** | 对话摘要机制，当 Token 数或消息数达到阈值时自动压缩历史消息，保持上下文窗口在限制内。 |
| **ThreadState** | 线程状态，LangGraph 中一次对话会话的完整状态对象，包含消息历史、计划和中间结果。 |
| **Thinking Mode** | 思考模式，让 LLM 在回答前进行显式推理的能力，由 `supports_thinking` 和 `when_thinking_enabled` 控制。 |
| **Tool** | 工具，Agent 可调用的外部能力单元，如 Web 搜索、文件读写、Bash 命令执行等。 |
| **ToolConfig** | 工具配置类，定义工具名称、分组和变量路径。 |
| **use 字段** | DeerFlow 配置中的动态加载标记，格式为 `package.module:ClassName`，通过反射在运行时导入。 |
