# 第 14 章　Sandbox 抽象层

Agent 能力的天花板取决于它能操作多大的世界。DeerFlow 给每个 Agent 配备了一台"虚拟计算机"——拥有完整的文件系统、Bash 执行环境和五种标准化工具。本章将剖析这套 Sandbox 抽象层的设计：从虚拟路径映射到工具接口，从抽象基类到三种具体实现。

## 14.1 /mnt/user-data：虚拟文件系统的起点

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

## 14.2 五个沙箱工具

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

## 14.3 延迟初始化：ensure_sandbox_initialized

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

## 14.4 Sandbox 抽象基类

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

## 14.5 三种实现

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

## 14.6 SandboxMiddleware 生命周期

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

## 小结

DeerFlow 的 Sandbox 抽象层通过虚拟路径 `/mnt/user-data` 统一了不同环境下的文件系统访问，通过 `Sandbox` 抽象基类统一了命令执行和文件操作的接口，通过五个标准化工具统一了 Agent 与计算环境的交互方式。Local、aio-sandbox、K8s 三种实现覆盖了从本地开发到生产部署的全部场景，而上层代码无需做任何适配。延迟初始化和中间件生命周期管理确保了资源的高效利用。下一章我们将深入 LocalSandbox 和 aio-sandbox 的具体实现细节。
