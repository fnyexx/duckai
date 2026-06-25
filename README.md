# DuckAI OpenAI Server

[English](README.md) | [简体中文](README_ZH.md)

A high-performance, OpenAI-compatible HTTP proxy server for the free anonymous Duck.ai (DuckDuckGo AI Chat) backend. It provides seamless access to multiple AI models through both the familiar **OpenAI Chat Completions API** and the modern **OpenAI Responses API** (`/v1/responses`).

---

## Features

- 🎯 **Dual API Style Compatibility**: Drop-in support for both `/v1/chat/completions` and `/v1/responses` (including full SSE event sequences).
- 🖼️ **Multimodal Support**: Seamless mapping of `image_url` (Base64 data URLs) to native image parts.
- 🎨 **Image Generation**: Automatically catches system component draw calls (DALL-E) and transforms them into standard inline Markdown image parts.
- 📂 **File Upload Injection**: Automatically parses base64-encoded `file` payload types and safely injects their content into the model context window.
- 🛠️ **Intelligent Tool Calling**: System prompt injection that maps function calling schemas to model decisions, returning standard `tool_calls` structure.
- 🚦 **Intelligent Rate Limiting**: Built-in sliding-window tracker persisted across processes via shared OS state file to respect DuckDuckGo limits.
- ☕ **WAF Challenge Bypass**: Evaluates DDG's complex JavaScript challenges dynamically in sandboxed environments, bypassing Cloudflare anti-bot shields.

### Supported Models

- `gpt-5.4-mini` (Default - maps to GPT-4o-mini backend)
- `gpt-5.4-nano` (Maps to GPT-4o-mini backend)
- `claude-haiku-4-5` (Maps to Claude 3.5 Haiku backend)

---

## Setup & Quick Start

### Option 1: Using Docker (Recommended)

```bash
# Pull the Docker image
docker pull fnyexx/duckai

# Run the container
docker run -p 3000:3000 fnyexx/duckai
```

The server will be available at `http://localhost:3000`.  
Docker Hub URL: [https://hub.docker.com/r/fnyexx/duckai/](https://hub.docker.com/r/fnyexx/duckai/)

### Option 2: Manual Setup

1. **Clone the repository**:
   ```bash
   git clone git@github.com:fnyexx/duckai.git
   cd duckai
   ```

2. **Install dependencies**:
   ```bash
   bun install
   ```

3. **Start the development server**:
   ```bash
   bun run dev
   ```

---

## API Endpoints

- `POST /v1/chat/completions` - Classic Chat Completions API (streaming & non-streaming)
- `POST /v1/responses` - OpenAI Responses API (streaming & non-streaming)
- `GET /v1/models` - List available models
- `GET /health` - Service health status

---

## Usage Examples

### 1. Chat Completions Example (SDK)

```javascript
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "dummy-key", // Any string works
});

const completion = await openai.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [{ role: "user", content: "Hello! How are you?" }],
});

console.log(completion.choices[0].message.content);
```

### 2. Responses API Example (HTTP Curl)

To test the Responses API style with streaming (Event Stream sequence):

```bash
curl -X POST http://localhost:3000/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4-mini",
    "input": [
      {
        "role": "user",
        "content": [
          { "type": "input_text", "text": "Who are you?" }
        ]
      }
    ],
    "stream": true
  }'
```

This returns standard Responses API events:
- `event: response.created`
- `event: response.output_item.added`
- `event: response.output_item.delta` (incremental token chunks)
- `event: response.output_item.done`
- `event: response.done`

### 3. File Upload Example (completions)

Upload a file and ask questions about its content directly using a text/plain base64 payload:

```javascript
const completion = await openai.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is the password inside the configuration file?" },
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

### 4. Tool Calling Example

```javascript
const tools = [
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Perform mathematical calculations",
      parameters: {
        type: "object",
        properties: {
          expression: { type: "string", description: "Expression to solve" }
        },
        required: ["expression"]
      }
    }
  }
];

const completion = await openai.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [{ role: "user", content: "What is 15 * 8?" }],
  tools: tools,
  tool_choice: "required"
});

console.log(completion.choices[0].message.tool_calls);
```

---

## Anti-Bot Wind Control & Troubleshooting (WAF)

### 418 I'm a Teapot (`ERR_BN_LIMIT`)

Duck.ai uses highly sophisticated Cloudflare Web Application Firewall (WAF) defenses. If you receive a `418` status code, it is due to one of the following detections:

1. **TLS Fingerprint Handshake matching (JA3/JA4)**: Standard node/bun fetch HTTP handshakes do not match web browser profiles (BoringSSL). Our server utilizes `got-scraping` to dynamically spoof Chromium TLS fingerprints.
2. **HTML5 Layout Verification**: The script dynamic challenge payload (`x-vqd-hash-1`) measures client screen layout attributes. In headless browsers or empty DOM test suites, elements report logical styles as `0`, failing checks. We evaluate DDG challenges inside a sandboxed `JSDOM` instance mocking offset dimensions.

**Development Recommendations:**
- **Local offline mock mode**: Start the server with `MOCK_DUCK_AI=true` to skip WAF connections entirely and mock all OpenAI API routes instantly.
- **Behind browser engines**: If WAF blocks persist in your network region, run the proxy behind chromium driver containers or use modern browser impersonators.

---

## License

MIT License. Unofficial proxy server for development and educational use cases.
