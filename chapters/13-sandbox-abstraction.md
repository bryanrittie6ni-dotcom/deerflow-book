# 第 13 章　Sandbox 抽象层

Agent 能力的天花板取决于它能操作多大的世界。DeerFlow 给每个 Agent 配备了一台"虚拟计算机"——拥有完整的文件系统、Bash 执行环境和五种标准化工具。本章将剖析这套 Sandbox 抽象层的设计：从虚拟路径映射到工具接口，从抽象基类到三种具体实现。

## 13.1 /mnt/user-data：虚拟文件系统的起点

DeerFlow 为所有 Sandbox 环境定义了统一的虚拟路径前缀：

```python
VIRTUAL_PATH_PREFIX = "/mnt/user-data"
```

这个命名来源于容器化环境的惯例——`/mnt/` 是 Linux 中挂载外部存储的标准目录。DeerFlow 在此基础上构建了三个子目录：

| 虚拟路径 | 用途 | 读写 |
|---------|------|------|
| `/mnt/user-data/uploads/` | 用户上传的文件 | 只读 |
| `/mnt/user-data/workspace/` | Agent 工作区 | 读写 |
| `/mnt/user-data/outputs/` | Agent 生成的输出 | 读写 |

此外，还有一个特殊的 skills 挂载目录，用于自定义 Agent 技能脚本。

对于 aio-sandbox 这样的容器化实现，`/mnt/user-data` 直接作为 Docker Volume 挂载进容器，路径天然存在。但对于 LocalSandbox，虚拟路径需要映射到宿主机的物理路径。`tools.py` 中的 `replace_virtual_path` 函数完成这一转换：

```python
def replace_virtual_path(path: str, thread_data: ThreadDataState | None) -> str:
    if not path.startswith(VIRTUAL_PATH_PREFIX):
        return path
    if thread_data is None:
        return path

    path_mapping = {
        "workspace": thread_data.get("workspace_path"),
        "uploads": thread_data.get("uploads_path"),
        "outputs": thread_data.get("outputs_path"),
    }

    relative_path = path[len(VIRTUAL_PATH_PREFIX):].lstrip("/")
    if not relative_path:
        return path

    parts = relative_path.split("/", 1)
    subdir = parts[0]
    rest = parts[1] if len(parts) > 1 else ""

    actual_base = path_mapping.get(subdir)
    if actual_base is None:
        return path

    if rest:
        return f"{actual_base}/{rest}"
    return actual_base
```

这种设计的精妙之处在于：Agent 的工具代码始终使用虚拟路径编写，完全不感知底层是本地文件系统还是远程容器。路径翻译对 Agent 透明。

## 13.2 五个沙箱工具

DeerFlow 提供了五个标准化的沙箱工具，覆盖了 Agent 与计算环境交互的核心需求：

### bash — 命令执行

```python
@tool("bash", parse_docstring=True)
def bash_tool(runtime: ToolRuntime, description: str, command: str) -> str:
    """Execute a bash command in a Linux environment."""
    sandbox = ensure_sandbox_initialized(runtime)
    ensure_thread_directories_exist(runtime)
    if is_local_sandbox(runtime):
        thread_data = get_thread_data(runtime)
        command = replace_virtual_paths_in_command(command, thread_data)
    return sandbox.execute_command(command)
```

每个工具都遵循相同的模式：获取 sandbox 实例 -> 确保目录存在 -> 本地沙箱时做路径替换 -> 委托给 sandbox 实现。

### ls — 目录浏览

列出目录内容（最多 2 层深度），以树形格式返回。

### read_file — 文件读取

支持按行范围读取（`start_line` / `end_line`），适合查看大文件的特定片段。

### write_file — 文件写入

支持覆盖和追加两种模式。

### str_replace — 精确替换

在文件中定位并替换子字符串，支持单次替换和全局替换。这个工具的存在避免了 Agent 需要先读取整个文件、修改后再完整写回的低效模式。

值得注意的是，每个工具的第一个参数都是 `description`——要求 Agent 在调用前先用自然语言解释"为什么要执行这个操作"。这不仅提升了可审计性，也帮助 LLM 在推理时更加谨慎。

## 13.3 延迟初始化：ensure_sandbox_initialized

并非所有 Agent 调用都需要 Sandbox。DeerFlow 采用延迟初始化策略，只在第一次使用沙箱工具时才创建沙箱实例：

```python
def ensure_sandbox_initialized(runtime: ToolRuntime | None = None) -> Sandbox:
    if runtime is None:
        raise SandboxRuntimeError("Tool runtime not available")

    # 检查是否已有 sandbox
    sandbox_state = runtime.state.get("sandbox")
    if sandbox_state is not None:
        sandbox_id = sandbox_state.get("sandbox_id")
        if sandbox_id is not None:
            sandbox = get_sandbox_provider().get(sandbox_id)
            if sandbox is not None:
                runtime.context["sandbox_id"] = sandbox_id
                return sandbox

    # 延迟获取：从 provider 申请新 sandbox
    thread_id = runtime.context.get("thread_id")
    if thread_id is None:
        raise SandboxRuntimeError("Thread ID not available")

    provider = get_sandbox_provider()
    sandbox_id = provider.acquire(thread_id)
    runtime.state["sandbox"] = {"sandbox_id": sandbox_id}

    sandbox = provider.get(sandbox_id)
    if sandbox is None:
        raise SandboxNotFoundError("Sandbox not found after acquisition", sandbox_id=sandbox_id)

    runtime.context["sandbox_id"] = sandbox_id
    return sandbox
```

获取后的 `sandbox_id` 被写入 `runtime.state`，后续工具调用可以直接复用，避免重复创建。

## 13.4 Sandbox 抽象基类

所有沙箱实现的统一接口定义在 `sandbox.py` 中：

```python
class Sandbox(ABC):
    _id: str

    def __init__(self, id: str):
        self._id = id

    @property
    def id(self) -> str:
        return self._id

    @abstractmethod
    def execute_command(self, command: str) -> str: ...

    @abstractmethod
    def read_file(self, path: str) -> str: ...

    @abstractmethod
    def list_dir(self, path: str, max_depth=2) -> list[str]: ...

    @abstractmethod
    def write_file(self, path: str, content: str, append: bool = False) -> None: ...

    @abstractmethod
    def update_file(self, path: str, content: bytes) -> None: ...
```

五个抽象方法对应五种基本文件系统操作。`update_file` 接受二进制内容，与 `write_file` 的文本模式互补。

## 13.5 三种实现

DeerFlow 提供了三种 Sandbox 实现，适用于不同的部署场景：

| 实现 | 类 | 场景 |
|------|------|------|
| Local | `LocalSandbox` | 开发调试，直接在宿主机执行 |
| aio-sandbox | `AioSandbox` | Docker 容器隔离，通过 HTTP API 交互 |
| K8s (Remote) | `RemoteSandboxBackend` | 生产环境，通过 Provisioner 动态创建 Pod |

三种实现共享同一个 `Sandbox` 抽象接口，上层的五个工具函数完全不需要知道底层使用的是哪种实现。配置文件中通过 `use` 字段指定：

```yaml
# Local 模式
sandbox:
  use: src.sandbox.local:LocalSandboxProvider

# aio-sandbox 模式
sandbox:
  use: src.community.aio_sandbox:AioSandboxProvider
  image: enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:latest
  port: 8080
  replicas: 3
```

`SandboxConfig` 使用 Pydantic 模型定义，支持丰富的配置选项：

```python
class SandboxConfig(BaseModel):
    use: str = Field(..., description="Class path of the sandbox provider")
    image: str | None = None
    port: int | None = None
    replicas: int | None = None
    container_prefix: str | None = None
    idle_timeout: int | None = None
    mounts: list[VolumeMountConfig] = Field(default_factory=list)
    environment: dict[str, str] = Field(default_factory=dict)
    model_config = ConfigDict(extra="allow")
```

`extra="allow"` 确保未知配置字段不会导致解析失败，为未来扩展留出空间。

## 13.6 SandboxMiddleware 生命周期

`SandboxMiddleware` 管理 Sandbox 的创建与释放：

```python
class SandboxMiddleware(AgentMiddleware[SandboxMiddlewareState]):
    def __init__(self, lazy_init: bool = True):
        super().__init__()
        self._lazy_init = lazy_init

    @override
    def before_agent(self, state, runtime) -> dict | None:
        if self._lazy_init:
            return super().before_agent(state, runtime)
        # 即时初始化
        if "sandbox" not in state or state["sandbox"] is None:
            thread_id = runtime.context["thread_id"]
            sandbox_id = self._acquire_sandbox(thread_id)
            return {"sandbox": {"sandbox_id": sandbox_id}}
        return super().before_agent(state, runtime)

    @override
    def after_agent(self, state, runtime) -> dict | None:
        sandbox = state.get("sandbox")
        if sandbox is not None:
            sandbox_id = sandbox["sandbox_id"]
            get_sandbox_provider().release(sandbox_id)
            return None
        # ...
```

默认的 `lazy_init=True` 模式下，`before_agent` 不做任何事情，Sandbox 的创建推迟到第一次工具调用。`after_agent` 负责释放——但对于 aio-sandbox，"释放"只是将容器放入热池（warm pool），并不真正销毁，下次复用时无需冷启动。

## 13.7 /mnt/ 命名的设计哲学

为什么选择 `/mnt/` 而不是 `/workspace/` 或 `/data/`？这个看似随意的命名决策背后隐藏着对 LLM 认知模型的深刻理解。

在 Linux 系统中，`/mnt/` 是传统的外部文件系统挂载点。当管理员挂载 USB 设备、网络共享或外部磁盘时，惯例性地挂载到 `/mnt/` 下。这一惯例已经深深嵌入了 LLM 的训练数据——大量的 Linux 教程、运维文档、Stack Overflow 回答都反复强化了这个语义：`/mnt/` 意味着"外部的、持久的、共享的存储"。

DeerFlow 正是利用了这一语义锚点。当 Agent 看到 `/mnt/user-data/workspace/` 路径时，LLM 会自然地将其理解为一块挂载进来的外部存储——它是持久的（不会随进程退出而消失）、是共享的（用户可以访问）、是"真实的"（不是临时缓存）。这种理解驱动 Agent 在操作文件时表现出恰当的行为：它会认真对待写入操作，不会随意覆盖已有文件，也不会把临时数据写到这个路径下。

这一设计灵感部分来源于 Claude 的 Mount drive 概念——Agent 将 `/mnt/` 视为自己的"外挂硬盘"。相比之下，其他 Agent 框架常用 `/workspace/` 或自定义路径，虽然功能上等价，但缺少了与 LLM 内在知识结构的对齐。命名不是任意的，它是 Prompt Engineering 在文件系统层面的延伸。

## 13.8 虚拟路径 → 物理路径的双向映射

虚拟路径的统一只是故事的一半。不同部署环境下，虚拟路径到物理路径的映射策略截然不同。

**Local Sandbox 的双向映射：**

```
/mnt/user-data/workspace/* → ~/.deerflow/threads/{thread_id}/user-data/workspace/*
/mnt/user-data/uploads/*   → ~/.deerflow/threads/{thread_id}/user-data/uploads/*
/mnt/user-data/outputs/*   → ~/.deerflow/threads/{thread_id}/user-data/outputs/*
/mnt/skills/*              → ~/.deerflow/skills/*
```

LocalSandbox 不仅做正向映射（虚拟路径 → 物理路径），还做反向映射：当命令执行的输出中包含物理路径时，`replace_physical_paths_in_output` 函数会将其转换回虚拟路径。这确保 Agent 永远不会看到宿主机的真实目录结构——既是安全考量，也避免 Agent 在后续推理中使用物理路径导致混乱。

**Docker（aio-sandbox）的恒等映射：**

```
/mnt/user-data/* → /mnt/user-data/* （恒等映射，Docker Volume 挂载）
/mnt/skills/*    → /mnt/skills/*    （恒等映射）
```

容器内部的文件系统已经通过 Docker Volume 挂载了这些路径，无需任何翻译。虚拟路径就是物理路径。

**K8s（Remote）的存储卷映射：**

```
/mnt/user-data/* → PersistentVolume 挂载到 Pod 内部
/mnt/skills/*    → ConfigMap 或 PV 挂载
```

同一份 Skill 代码、同一套工具函数，在三种环境下无缝运行。开发者在本地用 LocalSandbox 调试，测试环境用 aio-sandbox 隔离，生产环境用 K8s 弹性伸缩——代码一行不改。这就是虚拟路径抽象的价值。

## 13.9 五个沙箱工具的权限边界

五个工具各自有明确的能力边界：

| 工具 | 能做什么 | 不能做什么 |
|------|---------|-----------|
| bash | 在沙箱内执行任意命令，600 秒超时 | 无法逃逸沙箱边界，默认无网络访问控制 |
| ls | 列出目录内容，最多 2 层深度 | 无法超过 max_depth=2 的限制 |
| read_file | 读取沙箱内任意文件，支持行范围 | 不支持二进制文件（仅文本） |
| write_file | 写入/追加文本，自动创建父目录 | 不支持写入二进制内容 |
| str_replace | 文件内查找替换，支持单次和全局 | old_string 未找到时报错失败 |

值得注意的三个共性约束。第一，所有工具都要求 `description` 参数——Agent 必须在行动前解释"为什么"。这不是形式主义：它迫使 LLM 在 chain-of-thought 中显式推理操作意图，减少盲目执行的概率。第二，所有工具在执行前都会调用 `ensure_sandbox_initialized()`，确保沙箱实例已就绪。第三，在 LocalSandbox 模式下，所有工具还会调用 `ensure_thread_directories_exist()`，确保线程对应的物理目录已创建。

## 13.10 SandboxMiddleware 的三个阶段

中间件将 Sandbox 的生命周期管理拆分为获取、注入、释放三个阶段。

**阶段一：获取（Acquire）。** 当 `lazy_init=True`（默认值）时，`before_agent` 阶段不做任何事情，Sandbox 的获取推迟到第一次工具调用中的 `ensure_sandbox_initialized()`。当 `lazy_init=False` 时，`before_agent` 立即通过 `provider.acquire(thread_id)` 申请沙箱实例，返回 `sandbox_id`。

**阶段二：注入（Inject into State）。** 获取到的 `sandbox_id` 被写入两个位置：`runtime.state["sandbox"] = {"sandbox_id": sandbox_id}` 用于跨工具调用的持久化（通过 checkpointer 还能跨 turn 持久化），`runtime.context["sandbox_id"]` 用于清理阶段的快速引用。一个 Agent turn 内的多次工具调用共享同一个 sandbox_id，避免重复创建。

**阶段三：释放（Cleanup）。** `after_agent()` 检查 state 和 context 中的 sandbox_id，调用 `provider.release(sandbox_id)` 归还资源。但"释放"的语义因实现而异：对于 LocalSandbox，release 是空操作（单例模式，进程级别复用）；对于 aio-sandbox，release 将容器放回热池而非销毁，下次使用时免去冷启动开销。真正的资源回收发生在应用关闭时，由 `shutdown_sandbox_provider()` 统一处理。

## 13.11 sandbox_provider 的 lazy 初始化

Provider 本身也采用了延迟初始化模式。`get_sandbox_provider()` 函数维护一个全局的 `_default_sandbox_provider` 单例：

首次调用时，从 `config.yaml` 的 `sandbox.use` 字段读取类路径字符串（如 `src.sandbox.local:LocalSandboxProvider`），通过反射机制动态实例化 Provider 并缓存。后续调用直接返回缓存实例。

为什么要 lazy？因为在 Python 模块导入阶段，`config.yaml` 可能尚未加载完毕。如果在模块级别就实例化 Provider，会触发配置缺失的错误。延迟到第一次实际使用时初始化，确保配置已就绪。

为什么要单例？因为 Provider 管理着共享资源——aio-sandbox 的容器池、K8s 的集群连接。多实例会导致资源泄漏或状态不一致。

围绕这个单例，DeerFlow 还提供了三个辅助函数：`reset_sandbox_provider()` 清除缓存但不做清理，供测试用例在不同 Provider 之间切换；`shutdown_sandbox_provider()` 执行正式清理，调用 Provider 的 `shutdown()` 方法释放所有托管资源；`set_sandbox_provider()` 支持依赖注入，允许测试代码直接替换 Provider 实现而不依赖配置文件解析。

## 小结

DeerFlow 的 Sandbox 抽象层通过虚拟路径 `/mnt/user-data` 统一了不同环境下的文件系统访问，通过 `Sandbox` 抽象基类统一了命令执行和文件操作的接口，通过五个标准化工具统一了 Agent 与计算环境的交互方式。Local、aio-sandbox、K8s 三种实现覆盖了从本地开发到生产部署的全部场景，而上层代码无需做任何适配。延迟初始化和中间件生命周期管理确保了资源的高效利用。下一章我们将深入 LocalSandbox 和 aio-sandbox 的具体实现细节。
