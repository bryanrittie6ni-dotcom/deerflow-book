# 第 20 章　IM 渠道系统

DeerFlow 不仅是一个 Web 应用，还可以作为 IM 机器人嵌入到 Telegram、Slack 和飞书中。本章将深入分析 IM 渠道系统的架构设计，从抽象基类到消息总线，再到三个具体渠道的实现。

## 20.1 Channel 抽象基类

所有 IM 渠道实现都继承自 `channels/base.py` 中的 `Channel` 抽象基类：

```python
class Channel(ABC):
    """Base class for all IM channel implementations.

    Each channel connects to an external messaging platform and:
    1. Receives messages, wraps them as InboundMessage, publishes to the bus.
    2. Subscribes to outbound messages and sends replies back to the platform.
    """

    def __init__(self, name: str, bus: MessageBus, config: dict[str, Any]) -> None:
        self.name = name
        self.bus = bus
        self.config = config
        self._running = False

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    @abstractmethod
    async def send(self, msg: OutboundMessage) -> None: ...

    async def send_file(self, msg: OutboundMessage, attachment: ResolvedAttachment) -> bool:
        return False  # 默认不支持文件上传
```

基类定义了三个核心抽象方法（`start`、`stop`、`send`）和一个可选的文件上传方法。同时提供了两个模板方法：

**`_make_inbound`** — 创建入站消息的工厂方法：

```python
def _make_inbound(
    self, chat_id: str, user_id: str, text: str, *,
    msg_type: InboundMessageType = InboundMessageType.CHAT,
    thread_ts: str | None = None,
    files: list[dict[str, Any]] | None = None,
    metadata: dict[str, Any] | None = None,
) -> InboundMessage:
    return InboundMessage(
        channel_name=self.name, chat_id=chat_id, user_id=user_id,
        text=text, msg_type=msg_type, thread_ts=thread_ts, ...
    )
```

**`_on_outbound`** — 出站消息回调，自动过滤目标渠道并按序发送文本和文件：

```python
async def _on_outbound(self, msg: OutboundMessage) -> None:
    if msg.channel_name == self.name:
        try:
            await self.send(msg)  # 先发文本
        except Exception:
            return  # 文本失败则跳过文件

        for attachment in msg.attachments:
            await self.send_file(msg, attachment)
```

这个设计保证了文本消息和文件附件的发送顺序，且文本发送失败时不会尝试发送孤立的文件。

## 20.2 MessageBus — 异步消息总线

`channels/message_bus.py` 定义了整个渠道系统的消息模型和 Pub/Sub 中枢。

### 消息类型

系统定义了两种方向的消息：

```python
class InboundMessageType(StrEnum):
    CHAT = "chat"       # 普通聊天消息
    COMMAND = "command"  # 斜杠命令（如 /new, /help）

@dataclass
class InboundMessage:
    channel_name: str    # 来源渠道名
    chat_id: str         # 平台会话 ID
    user_id: str         # 平台用户 ID
    text: str            # 消息文本
    msg_type: InboundMessageType
    thread_ts: str | None = None   # 平台线程标识
    topic_id: str | None = None    # 映射到 DeerFlow 线程的话题 ID
    files: list[dict] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)
```

`topic_id` 是连接 IM 线程和 DeerFlow 线程的关键字段。同一个 `topic_id` 内的消息会复用同一个 DeerFlow 线程，实现多轮对话。当 `topic_id` 为 `None` 时，每条消息创建独立线程。

出站消息包含文本和文件附件：

```python
@dataclass
class ResolvedAttachment:
    virtual_path: str    # 虚拟路径
    actual_path: Path    # 主机路径
    filename: str
    mime_type: str
    size: int
    is_image: bool       # 图片可能有特殊处理

@dataclass
class OutboundMessage:
    channel_name: str    # 目标渠道
    chat_id: str
    thread_id: str       # DeerFlow 线程 ID
    text: str
    artifacts: list[str] = field(default_factory=list)
    attachments: list[ResolvedAttachment] = field(default_factory=list)
    is_final: bool = True
    thread_ts: str | None = None
```

`is_final` 标记用于通知渠道这是流式响应的最后一条消息，部分渠道（如飞书）会在最终消息发送后添加"完成"表情回应。

### 消息总线

`MessageBus` 实现了简洁的异步 Pub/Sub 模式：

```python
class MessageBus:
    def __init__(self) -> None:
        self._inbound_queue: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self._outbound_listeners: list[OutboundCallback] = []

    async def publish_inbound(self, msg: InboundMessage) -> None:
        await self._inbound_queue.put(msg)

    async def get_inbound(self) -> InboundMessage:
        return await self._inbound_queue.get()

    def subscribe_outbound(self, callback: OutboundCallback) -> None:
        self._outbound_listeners.append(callback)

    async def publish_outbound(self, msg: OutboundMessage) -> None:
        for callback in self._outbound_listeners:
            await callback(msg)
```

入站方向使用 `asyncio.Queue`——渠道生产消息，`ChannelManager` 消费消息并调度代理处理。出站方向使用回调列表——每个渠道在启动时注册 `_on_outbound` 回调，`ChannelManager` 发布出站消息时所有渠道都会收到通知，但只有 `channel_name` 匹配的渠道才实际发送。

## 20.3 ChannelService — 渠道生命周期管理

`channels/service.py` 中的 `ChannelService` 管理所有渠道的启停：

```python
_CHANNEL_REGISTRY: dict[str, str] = {
    "feishu": "src.channels.feishu:FeishuChannel",
    "slack": "src.channels.slack:SlackChannel",
    "telegram": "src.channels.telegram:TelegramChannel",
}

class ChannelService:
    def __init__(self, channels_config: dict[str, Any] | None = None) -> None:
        self.bus = MessageBus()
        self.store = ChannelStore()
        self.manager = ChannelManager(
            bus=self.bus, store=self.store,
            langgraph_url=langgraph_url, gateway_url=gateway_url,
            default_session=default_session, channel_sessions=channel_sessions,
        )

    async def start(self) -> None:
        await self.manager.start()
        for name, channel_config in self._config.items():
            if channel_config.get("enabled", False):
                await self._start_channel(name, channel_config)

    async def _start_channel(self, name: str, config: dict) -> bool:
        import_path = _CHANNEL_REGISTRY.get(name)
        channel_cls = resolve_class(import_path, base_class=None)
        channel = channel_cls(bus=self.bus, config=config)
        await channel.start()
        self._channels[name] = channel
```

渠道的注册使用字符串导入路径，通过 `resolve_class` 反射加载——这意味着只有实际启用的渠道才会导入其依赖库（如 `python-telegram-bot`、`slack-sdk`、`lark-oapi`），未安装的库不会导致启动失败。

`ChannelService` 作为全局单例，由 Gateway 的 `lifespan` 钩子在启动时创建：

```python
async def start_channel_service() -> ChannelService:
    global _channel_service
    _channel_service = ChannelService.from_app_config()
    await _channel_service.start()
    return _channel_service
```

## 20.4 三大渠道实现

### 19.4.1 Telegram

`TelegramChannel` 基于 `python-telegram-bot` 库，使用**长轮询**（Long Polling）模式，无需公网 IP：

```python
class TelegramChannel(Channel):
    async def start(self) -> None:
        from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, filters

        app = ApplicationBuilder().token(bot_token).build()
        app.add_handler(CommandHandler("start", self._cmd_start))
        app.add_handler(CommandHandler("new", self._cmd_generic))
        app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, self._on_text))

        # 在独立线程中运行轮询
        self._thread = threading.Thread(target=self._run_polling, daemon=True)
        self._thread.start()
```

Telegram 渠道在独立线程中运行事件循环，避免与主线程的 uvloop 冲突。消息处理链路为：

1. 收到用户消息后，先发送"Working on it..."回复
2. 将消息封装为 `InboundMessage` 发布到 MessageBus
3. `ChannelManager` 消费消息并调用 LangGraph Server 处理
4. 处理结果通过 MessageBus 出站回调发送回 Telegram

文件发送支持图片和文档两种模式，图片不超过 10MB 时用 `send_photo`，其余用 `send_document`（最大 50MB）。

配置示例：

```yaml
channels:
  telegram:
    enabled: true
    bot_token: "123456:ABC-DEF..."
    allowed_users: [12345678]  # 可选，限制允许使用的用户
```

### 19.4.2 Slack

`SlackChannel` 使用 **Socket Mode**（WebSocket），同样无需公网 IP：

```python
class SlackChannel(Channel):
    async def start(self) -> None:
        from slack_sdk import WebClient
        from slack_sdk.socket_mode import SocketModeClient

        self._web_client = WebClient(token=bot_token)
        self._socket_client = SocketModeClient(
            app_token=app_token, web_client=self._web_client,
        )
        self._socket_client.socket_mode_request_listeners.append(self._on_socket_event)

        # 后台线程启动 WebSocket 连接
        asyncio.get_event_loop().run_in_executor(None, self._socket_client.connect)
```

Slack 渠道有几个特色功能：

- **Markdown 转换**：使用 `SlackMarkdownConverter` 将标准 Markdown 转为 Slack 的 `mrkdwn` 格式。
- **表情反应**：收到消息时添加 :eyes: 反应表示已收到，处理完成后添加 :white_check_mark:，失败时添加 :x:。
- **线程对话**：使用 Slack 的 `thread_ts` 实现话题内回复，同一话题的消息共享 DeerFlow 线程。

配置需要两个 token：

```yaml
channels:
  slack:
    enabled: true
    bot_token: "xoxb-..."   # Bot User OAuth Token
    app_token: "xapp-..."   # App-Level Token (Socket Mode)
    allowed_users: ["U12345678"]
```

### 19.4.3 飞书

`FeishuChannel` 使用 `lark-oapi` 的 WebSocket 长连接模式：

```python
class FeishuChannel(Channel):
    async def start(self) -> None:
        import lark_oapi as lark

        self._api_client = lark.Client.builder() \
            .app_id(app_id).app_secret(app_secret).build()

        # WebSocket 在独立线程运行
        self._thread = threading.Thread(
            target=self._run_ws, args=(app_id, app_secret), daemon=True,
        )
        self._thread.start()

    def _run_ws(self, app_id, app_secret):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        # 修补 SDK 的模块级事件循环引用
        import lark_oapi.ws.client as _ws_client_mod
        _ws_client_mod.loop = loop

        event_handler = lark.EventDispatcherHandler.builder("", "") \
            .register_p2_im_message_receive_v1(self._on_message).build()
        ws_client = lark.ws.Client(
            app_id=app_id, app_secret=app_secret,
            event_handler=event_handler,
        )
        ws_client.start()
```

飞书渠道的实现有一个巧妙的 workaround：`lark-oapi` SDK 在模块级缓存了事件循环引用，当主线程使用 uvloop 时会导致冲突。DeerFlow 通过在独立线程中创建新事件循环并替换 SDK 的模块级引用来解决这个问题。

飞书的消息格式使用 Interactive Card（互动卡片）渲染 Markdown 内容：

```python
@staticmethod
def _build_card_content(text: str) -> str:
    card = {
        "config": {"wide_screen_mode": True},
        "elements": [{"tag": "markdown", "content": text}],
    }
    return json.dumps(card)
```

消息流程中的表情反应也更丰富——收到消息时添加 "OK" 反应，处理完成后添加 "DONE" 反应。

文件上传支持图片和文档两种模式，会自动根据扩展名判断文件类型（xls/ppt/pdf/doc/stream）。

配置示例：

```yaml
channels:
  feishu:
    enabled: true
    app_id: "cli_xxx..."
    app_secret: "xxx..."
```

## 20.5 实战：配置 Telegram Bot

以下是从零开始配置 Telegram 渠道的完整步骤：

**第一步**：在 Telegram 中找到 @BotFather，发送 `/newbot` 创建机器人，记录返回的 Bot Token。

**第二步**：在 `config.yaml` 中添加渠道配置：

```yaml
channels:
  langgraph_url: "http://localhost:2024"
  gateway_url: "http://localhost:8001"
  telegram:
    enabled: true
    bot_token: "123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxx"
    allowed_users: []  # 空列表允许所有用户
```

**第三步**：安装依赖并启动：

```bash
uv add python-telegram-bot
python -m uvicorn src.gateway.app:app --host 0.0.0.0 --port 8001
```

启动日志应显示：

```
INFO - Channel telegram started
INFO - ChannelService started with channels: ['telegram']
```

**第四步**：在 Telegram 中向机器人发送消息，即可开始对话。支持的命令包括 `/start`、`/new`、`/status`、`/models`、`/memory`、`/help`。

## 小结

DeerFlow 的 IM 渠道系统展现了优秀的架构设计：`Channel` 抽象基类定义了统一接口，`MessageBus` 通过异步 Queue 和回调列表实现了入站/出站消息的解耦，`ChannelService` 负责生命周期管理和延迟导入。三个渠道实现（Telegram、Slack、飞书）都采用了无需公网 IP 的连接方式（长轮询、Socket Mode、WebSocket），并各自处理了平台特有的消息格式、表情反应和文件上传逻辑。整个系统的扩展非常简单——只需继承 `Channel`、实现三个抽象方法、在 `_CHANNEL_REGISTRY` 中注册，即可接入新的 IM 平台。
