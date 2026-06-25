# DuckAI OpenAI 代理服务器

[English](README.md) | [简体中文](README_ZH.md)

一个高性能的、兼容 OpenAI HTTP 协议的代理网关服务器，用于对接免登录匿名的 Duck.ai (DuckDuckGo AI Chat) 后端。它通过大家熟知的 **OpenAI Chat Completions API** 和现代的 **OpenAI Responses API** (`/v1/responses`) 提供无缝的免费模型访问。

---

## 功能特性

- 🎯 **双 API 风格兼容**：开箱即用支持 `/v1/chat/completions` 和 `/v1/responses`（包括完整的流式 SSE 事件生命周期推送）。
- 🖼️ **多模态支持**：自动将 `image_url`（Base64 格式的 Data URL）解析并映射为底层的原生图像 payload 数据。
- 🎨 **在线生图**：自动捕获底层的系统绘图组件（DALL-E 调用），并将其直接转化为标准的行内 Markdown 图片链接返回。
- 📂 **文件上传注入**：自动拦截并解析客户端传入的 `type: "file"`（Base64 编码）文件，将其安全还原并作为上下文提示词注入至对话窗口，绕过匿名接口的上传限制。
- 🛠️ **智能工具调用**：通过系统提示词注入机制，将 OpenAI Function Calling 规范映射并引导模型决策，返回标准的 `tool_calls` JSON 结构。
- 🚦 **智能速率限制**：内置滑动窗口计数器，通过操作系统的共享临时状态文件跨进程同步，以严格遵守 DuckDuckGo 的调用速率限制。
- ☕ **绕过 WAF 人机验证**：在沙盒化 `JSDOM` 容器中动态模拟并执行 DDG 复杂的 JavaScript 人机验证脚本，自动生成合规的 `x-vqd-hash-1` 签名，绕过 Cloudflare 风控。

### 支持的模型

- `gpt-5.4-mini` (默认 - 映射至 GPT-4o-mini 后端)
- `gpt-5.4-nano` (映射至 GPT-4o-mini 后端)
- `claude-haiku-4-5` (映射至 Claude 3.5 Haiku 后端)

---

## 设置与快速开始

### 方式一：使用 Docker（推荐）

这是最简单的启动方式，直接拉取预构建的 Docker 镜像：

```bash
# 拉取 Docker 镜像
docker pull fnyexx/duckai

# 运行容器
docker run -p 3000:3000 fnyexx/duckai
```

服务将会在本地 `http://localhost:3000` 启动。  
Docker Hub 地址：[https://hub.docker.com/r/fnyexx/duckai/](https://hub.docker.com/r/fnyexx/duckai/)

### 方式二：手动配置启动

1. **克隆项目仓库**：
   ```bash
   git clone git@github.com:fnyexx/duckai.git
   cd duckai
   ```

2. **安装项目依赖**：
   ```bash
   bun install
   ```

3. **运行开发服务器**（支持热重载）：
   ```bash
   bun run dev
   ```

---

## 接口端点 (API Endpoints)

- `POST /v1/chat/completions` - 经典的 Chat Completions 接口（支持流式与非流式）
- `POST /v1/responses` - 兼容 OpenAI 的 Responses API 接口（支持流式与非流式）
- `GET /v1/models` - 获取可用模型列表
- `GET /health` - 服务健康状态检查

---

## 调用示例

### 1. 经典 Chat Completions 示例 (JavaScript SDK)

```javascript
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "dummy-key", // 任意字符串均可
});

const completion = await openai.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [{ role: "user", content: "你好！请用三个字回答你是什么模型？" }],
});

console.log(completion.choices[0].message.content);
```

### 2. Responses API 示例 (HTTP Curl)

运行并测试 Responses API 流式输出（Event Stream 序列）：

```bash
curl -X POST http://localhost:3000/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "input": [
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": "你是谁？" }
        ]
      }
    ],
    "stream": true
  }'
```

它将按照标准规范依次推送以下事件：
- `event: response.created`
- `event: response.output_item.added`
- `event: response.output_item.delta` （字符块增量）
- `event: response.output_item.done`
- `event: response.done`

### 3. 本地文件上传示例 (Completions)

你可以直接把本地文件以 base64 payload（文本类型）发送给模型，让其对文件内容进行问答：

```javascript
const completion = await openai.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "附带的配置文件中，DB_PASS 的密码是什么？" },
        {
          type: "file",
          content: Buffer.from("APP_ENV=prod\nDB_PASS=MySecret123").toString("base64"),
          encoding: "base64",
          mimeType: "text/plain",
          filename: "config.env"
        }
      ]
    }
  ]
});

console.log(completion.choices[0].message.content);
```

### 4. 工具调用示例 (Tool Calling)

```javascript
const tools = [
  {
    type: "function",
    function: {
      name: "calculate",
      description: "执行数学运算",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "待执行的数学公式" }
        },
        required: ["expression"]
      }
    }
  }
];

const completion = await openai.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [{ role: "user", content: "请问 15 * 8 等于多少？" }],
  tools: tools,
  tool_choice: "required"
});

console.log(completion.choices[0].message.tool_calls);
```

---

## 防风控机制与故障排查 (WAF)

### 418 I'm a Teapot (`ERR_BN_LIMIT`)

Duck.ai 后端使用了较为严格的 Cloudflare 和 Nginx 防爬防风控规则。如果你在调用时遇到了 `418` 状态码，通常是触发了以下风控防御：

1. **TLS 指纹握手匹配 (JA3/JA4)**：Node.js/Bun 默认的 fetch 底层握手指纹与常规浏览器不同。本项目在底层集成了 `got-scraping`，可以动态模拟真实的 Chromium TLS 握手指纹，保障底层通道畅通。
2. **HTML5 布局与 CSS 指标检测**：动态人机验证脚本（用于生成 `x-vqd-hash-1` 签名）会在内存中动态创建 DOM 节点并计算其几何属性。在无头浏览器中，这些值通常为 `0` 或不合逻辑。本项目在沙盒化 `JSDOM` 容器中完美 Mock 了这些几何布局指标，从而顺利绕过人机盾。

**本地开发建议：**
- **本地 Mock 模式**：本地调试时，建议启动服务器时设置 `MOCK_DUCK_AI=true`，这会在本地完全离线模拟所有 OpenAI 接口规范，无需真正连接网络风控后端。
- **配置代理与环境**：如果你的网络环境仍然被 Cloudflare 拦截，可以考虑在代理服务器后方挂载浏览器驱动（如 Playwright/Puppeteer）或使用指纹伪装容器。

---

## 开源协议

本项目基于 MIT 协议开源。仅供学习交流与开发测试使用，请严格遵守 DuckDuckGo 相关服务协议与频率限制。
