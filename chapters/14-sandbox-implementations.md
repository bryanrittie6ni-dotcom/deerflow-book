# 第 14 章　Local Sandbox 与 aio-sandbox 深度解析

上一章讲述了 Sandbox 的抽象设计，本章将钻入两种最常用的具体实现：适合本地开发的 `LocalSandbox`，以及字节跳动开源的容器化方案 `aio-sandbox`。我们将对比它们的路径映射策略、命令执行方式和生命周期管理，帮助读者根据场景做出正确的技术选型。

## 14.1 LocalSandbox：简单直接的本地执行

`LocalSandbox` 是最轻量的实现——它直接在宿主机上执行命令，不需要 Docker 或任何容器运行时。

### 路径映射

LocalSandbox 的核心挑战是将 Agent 使用的虚拟路径（如 `/mnt/skills/my_skill.py`）映射到宿主机上的物理路径。构造函数接受一个 `path_mappings` 字典：

```python
class LocalSandbox(Sandbox):
    def __init__(self, id: str, path_mappings: dict[str, str] | None = None):
        super().__init__(id)
        self.path_mappings = path_mappings or {}
```

路径解析采用最长前缀匹配：

```python
def _resolve_path(self, path: str) -> str:
    path_str = str(path)
    for container_path, local_path in sorted(
        self.path_mappings.items(), key=lambda x: len(x[0]), reverse=True
    ):
        if path_str.startswith(container_path):
            relative = path_str[len(container_path):].lstrip("/")
            resolved = str(Path(local_path) / relative) if relative else local_path
            return resolved
    return path_str
```

按容器路径长度降序排序保证了更具体的映射优先匹配。例如 `/mnt/skills/python/` 会优先于 `/mnt/skills/` 被匹配。

### 双向路径转换

LocalSandbox 不仅需要正向解析（虚拟 -> 物理），还需要反向解析（物理 -> 虚拟）。当命令执行后，输出中可能包含宿主机的物理路径，这些路径对 Agent 来说毫无意义。`_reverse_resolve_paths_in_output` 方法将输出中的物理路径替换回虚拟路径：

```python
def execute_command(self, command: str) -> str:
    resolved_command = self._resolve_paths_in_command(command)
    result = subprocess.run(
        resolved_command,
        executable=self._get_shell(),
        shell=True,
        capture_output=True,
        text=True,
        timeout=600,
    )
    output = result.stdout
    if result.stderr:
        output += f"\nStd Error:\n{result.stderr}" if output else result.stderr
    if result.returncode != 0:
        output += f"\nExit Code: {result.returncode}"
    final_output = output if output else "(no output)"
    # 物理路径 → 虚拟路径
    return self._reverse_resolve_paths_in_output(final_output)
```

命令输入时做正向转换，输出时做反向转换，形成一个闭环——Agent 始终生活在虚拟路径的世界中。

### Shell 选择

```python
@staticmethod
def _get_shell() -> str:
    for shell in ("/bin/zsh", "/bin/bash", "/bin/sh"):
        if os.path.isfile(shell) and os.access(shell, os.X_OK):
            return shell
    shell_from_path = shutil.which("sh")
    if shell_from_path is not None:
        return shell_from_path
    raise RuntimeError("No suitable shell executable found.")
```

优先使用 zsh（macOS 默认），依次回退到 bash、sh。这保证了在各种操作系统上都能运行。

### LocalSandboxProvider：单例模式

```python
class LocalSandboxProvider(SandboxProvider):
    def acquire(self, thread_id: str | None = None) -> str:
        global _singleton
        if _singleton is None:
            _singleton = LocalSandbox("local", path_mappings=self._path_mappings)
        return _singleton.id

    def release(self, sandbox_id: str) -> None:
        pass  # 单例模式，不需要释放
```

所有线程共享同一个 LocalSandbox 实例，`release` 是空操作。这在开发环境中完全合理——没有容器需要管理。

## 14.2 aio-sandbox：字节开源的容器化方案

aio-sandbox（All-In-One Sandbox）是字节跳动开源的沙箱容器，提供了真正的进程隔离。DeerFlow 通过 HTTP API 与之交互。

### AioSandbox 实现

```python
class AioSandbox(Sandbox):
    def __init__(self, id: str, base_url: str, home_dir: str | None = None):
        super().__init__(id)
        self._base_url = base_url
        self._client = AioSandboxClient(base_url=base_url, timeout=600)
        self._home_dir = home_dir

    def execute_command(self, command: str) -> str:
        result = self._client.shell.exec_command(command=command)
        output = result.data.output if result.data else ""
        return output if output else "(no output)"

    def read_file(self, path: str) -> str:
        result = self._client.file.read_file(file=path)
        return result.data.content if result.data else ""

    def write_file(self, path: str, content: str, append: bool = False) -> None:
        if append:
            existing = self.read_file(path)
            if not existing.startswith("Error:"):
                content = existing + content
        self._client.file.write_file(file=path, content=content)
```

与 LocalSandbox 最大的区别在于：aio-sandbox 不需要做路径转换。容器内的 `/mnt/user-data` 目录是通过 Docker Volume 真实挂载的，Agent 使用的虚拟路径就是容器内的真实路径。

对于二进制文件，`update_file` 使用 base64 编码通过 HTTP 传输：

```python
def update_file(self, path: str, content: bytes) -> None:
    base64_content = base64.b64encode(content).decode("utf-8")
    self._client.file.write_file(file=path, content=base64_content, encoding="base64")
```

### AioSandboxProvider：完整的容器生命周期

`AioSandboxProvider` 是 DeerFlow 中最复杂的 Provider 实现，管理着容器的完整生命周期。

**确定性 ID 生成。** 同一个 `thread_id` 始终映射到同一个 `sandbox_id`：

```python
@staticmethod
def _deterministic_sandbox_id(thread_id: str) -> str:
    return hashlib.sha256(thread_id.encode()).hexdigest()[:8]
```

这个设计使得多个进程可以独立推导出相同的容器名，无需共享状态即可实现跨进程的 sandbox 复用。

**三层获取策略。** `_acquire_internal` 按优先级尝试三种方式获取 sandbox：

1. **内存缓存**（最快）：进程内的 `_sandboxes` 字典直接命中。
2. **热池复用**（次快）：容器还在运行但已被释放，从 `_warm_pool` 中取回，无需冷启动。
3. **后端发现/创建**（最慢）：通过文件锁序列化，先尝试发现其他进程创建的容器，找不到才新建。

**热池（Warm Pool）设计。** 当 Agent 执行完毕后，`release()` 并不销毁容器，而是将其放入热池：

```python
def release(self, sandbox_id: str) -> None:
    with self._lock:
        self._sandboxes.pop(sandbox_id, None)
        info = self._sandbox_infos.pop(sandbox_id, None)
        # ...
        if info and sandbox_id not in self._warm_pool:
            self._warm_pool[sandbox_id] = (info, time.time())
```

热池中的容器可以被快速复用。当 `replicas` 上限被触及时，最久未使用的热池容器会被驱逐（LRU 策略）。

**空闲超时。** 后台守护线程每 60 秒检查一次，超过 `idle_timeout`（默认 600 秒）未活动的容器会被自动销毁。

## 14.3 sandbox_config.yaml 配置详解

一个完整的 aio-sandbox 配置示例：

```yaml
sandbox:
  use: src.community.aio_sandbox:AioSandboxProvider
  image: enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:latest
  port: 8080
  replicas: 3
  container_prefix: deer-flow-sandbox
  idle_timeout: 600
  mounts:
    - host_path: /data/shared
      container_path: /mnt/shared
      read_only: false
  environment:
    NODE_ENV: production
    API_KEY: $MY_API_KEY    # $ 前缀从宿主机环境变量解析
```

环境变量中以 `$` 开头的值会在运行时从宿主机环境中解析：

```python
@staticmethod
def _resolve_env_vars(env_config: dict[str, str]) -> dict[str, str]:
    resolved = {}
    for key, value in env_config.items():
        if isinstance(value, str) and value.startswith("$"):
            env_name = value[1:]
            resolved[key] = os.environ.get(env_name, "")
        else:
            resolved[key] = str(value)
    return resolved
```

K8s 远程模式只需额外配置 `provisioner_url`：

```yaml
sandbox:
  use: src.community.aio_sandbox:AioSandboxProvider
  provisioner_url: http://provisioner:8002
```

Provider 会自动选择 `RemoteSandboxBackend`，通过 HTTP API 与 Provisioner 通信，由后者在 k3s 中动态创建 Pod 和 NodePort Service。

## 14.4 实战对比三种 Sandbox

| 维度 | LocalSandbox | aio-sandbox (Local) | aio-sandbox (K8s) |
|------|-------------|--------------------|--------------------|
| 隔离级别 | 无（宿主机直接执行） | 容器级 | Pod 级 |
| 启动速度 | 即时 | 首次约 5-10s，热池复用即时 | 首次约 10-30s |
| 路径映射 | 双向转换 | Docker Volume 直挂 | Docker Volume 直挂 |
| 适用场景 | 本地开发/调试 | 单机部署/CI | 生产环境/多租户 |
| 资源管理 | 无 | replicas + 空闲超时 | K8s 调度 |
| 安全性 | 低（可访问宿主机） | 中（容器隔离） | 高（Pod + 网络策略） |
| 依赖 | 无 | Docker | K8s + Provisioner |

开发阶段推荐使用 LocalSandbox，零依赖即可开始。需要安全隔离的场景切换到 aio-sandbox，只需修改配置文件中的 `use` 字段，Agent 代码无需任何改动。

## 14.5 SandboxMiddleware 生命周期总结

把中间件与 Provider 的交互串联起来，Sandbox 的完整生命周期如下：

1. **Agent 启动** → `SandboxMiddleware.before_agent()`
   - `lazy_init=True`（默认）：跳过，什么都不做。
   - `lazy_init=False`：立即调用 `provider.acquire(thread_id)`。

2. **首次工具调用** → `ensure_sandbox_initialized()`
   - 从 Provider 获取或创建 Sandbox 实例。
   - 将 `sandbox_id` 写入 `runtime.state` 以便后续复用。

3. **Agent 完成** → `SandboxMiddleware.after_agent()`
   - 调用 `provider.release(sandbox_id)`。
   - LocalSandbox：空操作（单例常驻）。
   - AioSandbox：容器进入热池，不真正销毁。

4. **空闲超时 / 容量驱逐 / 应用关闭** → `provider.destroy(sandbox_id)`
   - 真正停止并移除容器。

这种分层设计确保了资源的高效利用：不需要 Sandbox 的 Agent 调用零开销，需要的则按需创建、跨轮次复用、空闲自动回收。

## 小结

LocalSandbox 通过双向路径映射在宿主机上模拟了容器环境，适合开发调试。aio-sandbox 作为字节跳动开源的容器化方案，提供了真正的进程隔离，其热池机制和确定性 ID 生成实现了高效的容器复用和跨进程一致性。K8s 远程模式则通过 Provisioner 将沙箱管理委托给 Kubernetes，适合生产环境的多租户场景。三种实现共享同一套抽象接口和工具函数，切换部署模式只需要修改一行配置——这正是良好抽象的价值所在。
