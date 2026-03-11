# 第 21 章　模型配置与适配

DeerFlow 的模型层设计目标是让用户能够自由接入任意 LLM 提供商，同时统一处理"思考模式"、"视觉输入"等差异化能力。本章深入解析模型配置的数据结构、工厂函数的工作机制，以及 PatchedChatDeepSeek 的补丁逻辑。

## 21.1 ModelConfig 数据结构

每个模型在 `config.yaml` 的 `models` 列表中对应一个条目，由 `ModelConfig` 验证：

```python
# backend/src/config/model_config.py
class ModelConfig(BaseModel):
    name: str                    # 唯一标识符
    display_name: str | None     # 前端展示名称
    description: str | None      # 模型描述
    use: str                     # 类路径，如 "langchain_openai:ChatOpenAI"
    model: str                   # 模型名称，如 "gpt-4"
    supports_thinking: bool      # 是否支持思考/推理模式
    supports_reasoning_effort: bool  # 是否支持推理力度调节
    supports_vision: bool        # 是否支持图像输入
    when_thinking_enabled: dict | None   # 思考模式启用时的额外参数
    thinking: dict | None        # thinking 快捷字段
    model_config = ConfigDict(extra="allow")  # 允许传入任意额外参数
```

`extra="allow"` 是关键设计——它允许不同提供商的特有参数（如 `api_key`、`api_base`、`base_url`、`max_tokens`、`temperature`、`google_api_key` 等）直接透传，无需预先定义。

## 21.2 use 字段与动态加载

`use` 字段的格式为 `package.module:ClassName`，工厂函数通过反射机制在运行时加载：

```python
# backend/src/reflection/resolvers.py
def resolve_class(class_path: str, base_class: type | None = None) -> type:
    model_class = resolve_variable(class_path, expected_type=type)
    if base_class is not None and not issubclass(model_class, base_class):
        raise ValueError(f"{class_path} is not a subclass of {base_class.__name__}")
    return model_class
```

`resolve_variable` 内部使用 `importlib.import_module` 完成动态导入，并对已知的 LangChain 集成包提供友好的错误提示：

```python
MODULE_TO_PACKAGE_HINTS = {
    "langchain_google_genai": "langchain-google-genai",
    "langchain_anthropic": "langchain-anthropic",
    "langchain_openai": "langchain-openai",
    "langchain_deepseek": "langchain-deepseek",
}
```

当依赖包缺失时，错误信息会直接告诉你该运行 `uv add langchain-openai`。

## 21.3 create_chat_model 工厂函数

`create_chat_model` 是模型实例化的核心入口：

```python
# backend/src/models/factory.py
def create_chat_model(
    name: str | None = None,
    thinking_enabled: bool = False,
    **kwargs
) -> BaseChatModel:
    config = get_app_config()
    if name is None:
        name = config.models[0].name  # 默认取第一个模型

    model_config = config.get_model_config(name)
    model_class = resolve_class(model_config.use, BaseChatModel)
```

工厂函数的参数处理分为三步：

**第一步：提取模型设置。** 将 `ModelConfig` 序列化为字典，同时排除元数据字段：

```python
model_settings_from_config = model_config.model_dump(
    exclude_none=True,
    exclude={
        "use", "name", "display_name", "description",
        "supports_thinking", "supports_reasoning_effort",
        "when_thinking_enabled", "thinking", "supports_vision",
    },
)
```

排除后剩下的就是纯粹的模型构造参数（`model`、`api_key`、`max_tokens` 等），可以直接传给 LangChain 的模型类。

**第二步：合并 thinking 配置。** `thinking` 是 `when_thinking_enabled` 的快捷写法，两者会被合并：

```python
effective_wte = dict(model_config.when_thinking_enabled) if ... else {}
if model_config.thinking is not None:
    merged_thinking = {
        **(effective_wte.get("thinking") or {}),
        **model_config.thinking
    }
    effective_wte = {**effective_wte, "thinking": merged_thinking}
```

**第三步：根据 thinking_enabled 开关决定行为。** 这里有一个精妙的设计——当思考模式被**关闭**时，工厂函数会主动注入 `"type": "disabled"` 来显式禁用：

```python
if not thinking_enabled and has_thinking_settings:
    if effective_wte.get("extra_body", {}).get("thinking", {}).get("type"):
        # OpenAI 兼容网关：thinking 嵌套在 extra_body 下
        kwargs.update({"extra_body": {"thinking": {"type": "disabled"}}})
        kwargs.update({"reasoning_effort": "minimal"})
    elif effective_wte.get("thinking", {}).get("type"):
        # 原生 langchain_anthropic：thinking 是直接构造参数
        kwargs.update({"thinking": {"type": "disabled"}})
```

这区分了两种 API 风格：OpenAI 兼容接口（DeepSeek、豆包等通过 `extra_body` 传递）和 Anthropic 原生接口（直接传 `thinking` 参数）。

最后实例化并可选地附加 LangSmith 追踪：

```python
model_instance = model_class(**kwargs, **model_settings_from_config)

if is_tracing_enabled():
    tracer = LangChainTracer(project_name=tracing_config.project)
    model_instance.callbacks = [*existing_callbacks, tracer]
```

## 21.4 PatchedChatDeepSeek

DeepSeek 的思考模式要求多轮对话中每条 assistant 消息都携带 `reasoning_content` 字段，但 LangChain 的默认实现将其存储在 `additional_kwargs` 中、发送时却不包含。`PatchedChatDeepSeek` 通过重写 `_get_request_payload` 修复了这个问题：

```python
# backend/src/models/patched_deepseek.py
class PatchedChatDeepSeek(ChatDeepSeek):
    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        original_messages = self._convert_input(input_).to_messages()
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)

        payload_messages = payload.get("messages", [])
        if len(payload_messages) == len(original_messages):
            for payload_msg, orig_msg in zip(payload_messages, original_messages):
                if payload_msg.get("role") == "assistant" and isinstance(orig_msg, AIMessage):
                    reasoning_content = orig_msg.additional_kwargs.get("reasoning_content")
                    if reasoning_content is not None:
                        payload_msg["reasoning_content"] = reasoning_content
        return payload
```

这个补丁同样适用于豆包（Volcengine Doubao）和 Kimi 等兼容 DeepSeek 协议的模型。

## 21.5 推荐模型搭配

根据 `config.example.yaml` 中的示例，以下是几种典型配置：

**通用场景（OpenAI）：**

```yaml
- name: gpt-4
  use: langchain_openai:ChatOpenAI
  model: gpt-4
  api_key: $OPENAI_API_KEY
  max_tokens: 4096
  supports_vision: true
```

**深度推理场景（DeepSeek）：**

```yaml
- name: deepseek-v3
  use: src.models.patched_deepseek:PatchedChatDeepSeek
  model: deepseek-reasoner
  api_key: $DEEPSEEK_API_KEY
  supports_thinking: true
  when_thinking_enabled:
    extra_body:
      thinking:
        type: enabled
```

**多模态场景（Anthropic Claude）：**

```yaml
- name: claude-3-5-sonnet
  use: langchain_anthropic:ChatAnthropic
  model: claude-3-5-sonnet-20241022
  api_key: $ANTHROPIC_API_KEY
  max_tokens: 8192
  supports_vision: true
  when_thinking_enabled:
    thinking:
      type: enabled
```

**国产模型（豆包 Doubao）：**

```yaml
- name: doubao-seed-1.8
  use: src.models.patched_deepseek:PatchedChatDeepSeek
  model: doubao-seed-1-8-251228
  api_base: https://ark.cn-beijing.volces.com/api/v3
  api_key: $VOLCENGINE_API_KEY
  supports_thinking: true
  supports_vision: true
  supports_reasoning_effort: true
```

可以同时配置多个模型，`models` 列表中的第一个模型作为默认模型。前端会展示所有配置的模型供用户切换。

## 小结

DeerFlow 的模型配置通过 `use` 字段实现了"配置即代码"的理念——无需修改源码，仅通过 YAML 就能接入任意 LangChain 兼容的模型提供商。`ModelConfig` 的 `extra="allow"` 设计让不同提供商的参数可以自由透传，`when_thinking_enabled` 和 `thinking` 的合并机制统一处理了 OpenAI 兼容和 Anthropic 两种思考模式 API 的差异，而 `PatchedChatDeepSeek` 则修补了多轮推理对话中的协议兼容问题。这套设计在保持灵活性的同时，将模型适配的复杂度封装在了工厂函数内部。
