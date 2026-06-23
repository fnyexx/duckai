# DuckAI OpenAI Server

A high-performance OpenAI-compatible HTTP server that uses DuckDuckGo's AI backend, providing free access to multiple AI models through the familiar OpenAI API interface.

## Setup & Quick Start

### Option 1: Using Docker (Recommended)

The easiest way to get started is using the pre-built Docker image:

```bash
# Pull the Docker image
docker pull amirkabiri/duckai

# Run the container
docker run -p 3000:3000 amirkabiri/duckai
```

The server will be available at `http://localhost:3000`.

Docker image URL: [https://hub.docker.com/r/amirkabiri/duckai/](https://hub.docker.com/r/amirkabiri/duckai/)

### Option 2: Manual Setup

1. Clone the repository:
```bash
git clone git@github.com:amirkabiri/duckai.git
cd duckai
```

2. Install dependencies:
```bash
bun install
```

3. Start the server:
```bash
bun run dev
```

### Basic Usage Example

```javascript
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "dummy-key", // Any string works
});

// Chat completion
const completion = await openai.chat.completions.create({
  model: "gpt-5.4-mini", // Default model
  messages: [
    { role: "user", content: "Hello! How are you?" }
  ],
});

console.log(completion.choices[0].message.content);
```

## Introduction

DuckAI OpenAI Server bridges the gap between DuckDuckGo's free AI chat service and the widely-adopted OpenAI API format. This allows you to:

- **Use multiple AI models for free** - Access GPT-5.4-mini, Claude-Haiku-4.5, and GPT-5.4-nano
- **Drop-in OpenAI replacement** - Compatible with existing OpenAI client libraries
- **Tool calling support** - Full function calling capabilities
- **Streaming responses** - Real-time response streaming
- ✅ Rate limiting - Built-in intelligent rate limiting to respect DuckDuckGo's limits

### Supported Models

- `gpt-5.4-mini` (Default)
- `gpt-5.4-nano`
- `claude-haiku-4-5`

### Features

- ✅ Chat completions
- ✅ Streaming responses
- ✅ Function/tool calling
- ✅ Multiple model support
- ✅ Rate limiting with intelligent backoff
- ✅ OpenAI-compatible error handling
- ✅ CORS support
- ✅ Health check endpoint

## Usage

### Prerequisites

- [Bun](https://bun.sh/) runtime (recommended) or Node.js 18+

### Installation

1. Clone the repository:
```bash
git clone git@github.com:amirkabiri/duckai.git
cd duckai
```

2. Install dependencies:
```bash
bun install
```

3. Start the server:
```bash
bun run dev
```

The server will start on `http://localhost:3000` by default.

### Basic Usage

#### Using with OpenAI JavaScript Library

```javascript
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: "http://localhost:3000/v1",
  apiKey: "dummy-key", // Any string works
});

// Basic chat completion
const completion = await openai.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [
    { role: "user", content: "Hello! How are you?" }
  ],
});

console.log(completion.choices[0].message.content);
```

#### Tool Calling Example

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
          expression: {
            type: "string",
            description: "Mathematical expression to evaluate"
          }
        },
        required: ["expression"]
      }
    }
  }
];

const completion = await openai.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [
    { role: "user", content: "What is 15 * 8?" }
  ],
  tools: tools,
  tool_choice: "auto"
});

// The AI will call the calculate function
console.log(completion.choices[0].message.tool_calls);
```

#### Streaming Responses

```javascript
const stream = await openai.chat.completions.create({
  model: "gpt-5.4-mini",
  messages: [
    { role: "user", content: "Tell me a story" }
  ],
  stream: true
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) {
    process.stdout.write(content);
  }
}
```

#### Using with curl

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer dummy-key" \
  -d '{
    "model": "gpt-5.4-mini",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

### API Endpoints

- `POST /v1/chat/completions` - Chat completions (compatible with OpenAI)
- `GET /v1/models` - List available models
- `GET /health` - Health check endpoint

### Environment Variables

- `PORT` - Server port (default: 3000)
- `HOST` - Server host (default: 0.0.0.0)

## Usage with Docker

### Building the Docker Image

```bash
docker build -t duckai .
```

### Running with Docker

```bash
docker run -p 3000:3000 duckai
```

## Troubleshooting & Anti-Bot Wind Control (WAF)

### 418 I'm a Teapot (ERR_BN_LIMIT)

Duck.ai (DuckDuckGo AI Chat) uses highly sophisticated Cloudflare & Nginx anti-bot shield rules. If you attempt to connect and receive a `418` status code with `ERR_BN_LIMIT` or `ERR_CHALLENGE`, it is likely due to the following WAF defenses:

1. **TLS Fingerprint matching (JA3/JA4)**: The standard fetch in Node.js/Bun uses the native OpenSSL stack which sends TLS handshakes that look different from modern browsers (BoringSSL). When WAF detects a standard User-Agent header (like Chrome) but paired with a Node.js/Bun TLS handshake, it instantly blocks with 418.
2. **HTML5 Parsing & CSS Layout Spoor**: The dynamic challenge payload (`x-vqd-hash-1`) runs an evaluation script in memory. It measures native DOM metrics (such as `offsetWidth`, `scrollHeight`, and `getBoundingClientRect`) of dynamically appended elements (like `li` and `div`). In mock environments (JSDOM), these evaluate as `0` or violate logical styling constraints (e.g. `li` element width identical to `div`), revealing headless bot activity.

**Recommendations:**
* **Use Local Mocking (Recommended for development)**: Start the server with `MOCK_DUCK_AI=true` to bypass the backend WAF check completely and test all OpenAI SDK features (tool calling, streaming, models list, CORS) locally offline.
* **Spoofing TLS**: We integrated `got-scraping` into `src/duckai.ts` to spoof Chrome TLS handshakes and inject Client Hints (`sec-ch-ua`, `Origin`, etc.) in application headers. If WAF blocks persist in your network environment, consider running the proxy behind a Chromium-based driver instance (like Playwright/Puppeteer) or a browser-impersonating container (e.g., `curl-impersonate`).

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Run the test suite
6. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Disclaimer

This project is not affiliated with DuckDuckGo or OpenAI. It's an unofficial bridge service for educational and development purposes. Please respect DuckDuckGo's terms of service and rate limits.
