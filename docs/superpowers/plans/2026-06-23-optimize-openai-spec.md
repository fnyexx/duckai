# OpenAI兼容性代理接口优化计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化接口设计以完全符合 OpenAI API 规范，使其能无缝兼容 Dify、LangChain 以及官方 OpenAI SDK 等第三方工具。

**Architecture:** 
1. 增强模型名称映射逻辑，使得发往代理的所有通用模型别名（如 `gpt-4o`、`gpt-3.5-turbo`）都能正确转译为后端 `duck.ai` 可识别的模型 ID，避免透传非法模型导致的请求失败。
2. 修复流式传输（Streaming）首包返回逻辑：标准的 OpenAI 流式首包包含 `{ "role": "assistant" }` 而不带有 `content` 字段，后面的包才包含内容。
3. 补齐 Error 返回字段：错误响应格式补全 `param` 和 `code` 字段，确保符合 OpenAI 错误响应模型定义。

**Tech Stack:** TypeScript, Bun, OpenAI API, got-scraping, SSE

---

### Task 1: 优化模型别名映射逻辑

**Files:**
- Modify: `src/openai-service.ts`
- Test: `tests/openai-simple.test.ts` (添加用例测试模型映射)

- [ ] **Step 1: 修改 transformToDuckAIRequest 方法，增加模型映射逻辑**

在 `src/openai-service.ts` 的模型转换方法中，将常见的 `gpt-4o` 等映射到后端实际支持的模型，如 `gpt-5.4-mini` 或 `claude-haiku-4-5`。同时支持原生的 `gpt-5.4-mini`。

```typescript
// src/openai-service.ts
  private transformToDuckAIRequest(
    request: ChatCompletionRequest
  ): DuckAIRequest {
    const modelMap: Record<string, string> = {
      "gpt-4o": "gpt-5.4-mini",
      "gpt-4o-mini": "gpt-5.4-mini",
      "gpt-4-turbo": "gpt-5.4-mini",
      "gpt-4": "gpt-5.4-mini",
      "gpt-3.5-turbo": "gpt-5.4-mini",
      "claude-3-5-sonnet": "claude-haiku-4-5",
      "claude-3-opus": "claude-haiku-4-5",
    };

    const requestedModel = request.model || "gpt-5.4-mini";
    const targetModel = modelMap[requestedModel] || requestedModel;

    return {
      model: targetModel,
      messages: request.messages,
    };
  }
```

- [ ] **Step 2: 在测试文件中补充测试别名模型映射的用例**

在 `tests/openai-simple.test.ts` 里的 `describe("Chat Completions API")` 内添加一个测试用例，用 `gpt-4o` 调用接口，看是否在 Mock 模式下返回正确的 Model ID。

```typescript
    it("should map common OpenAI models to DuckAI backend models", async () => {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Say hello" }],
      });

      expect(completion.object).toBe("chat.completion");
      // 注意：OpenAI 官方规范通常返回请求时发送的 model 名称
      expect(completion.model).toBe("gpt-4o");
    });
```
由于规范中，服务端通常在响应中把请求时的 `model`（即 `gpt-4o`）原样带回（这样客户端 SDK 校验才不会报错），所以我们应该在 `createChatCompletion` 和 `createChatCompletionStream` 返回中保留 `request.model`！

让我们检查 `createChatCompletion` 的实现，它是怎么处理返回的 `model` 的：
```typescript
    return {
      id,
      object: "chat.completion",
      created,
      model: request.model, // 这里已经带回了原始的 request.model，很棒！
      ...
```
所以我们只需要修改 `transformToDuckAIRequest` 传给底层 `duckAI` 的参数就行，外面暴露的 `model` 保持原状！

- [ ] **Step 3: 运行测试验证**

Run: `bun test tests/openai-simple.test.ts`
Expected: 模型映射相关的测试通过。

---

### Task 2: 修复流式传输首包结构与 Tool Call 流式首包

**Files:**
- Modify: `src/openai-service.ts:357-416` (优化普通流式首包), `src/openai-service.ts:474-540` (优化工具调用流式首包)
- Test: `tests/openai-simple.test.ts`

- [ ] **Step 1: 修改普通流式传输方法 `createChatCompletionStream`**

调整 `ReadableStream` 生成逻辑，确保第一个事件仅推送包含 `role: "assistant"` 的包，随后的内容包只推送 `content` 字段。

```typescript
// src/openai-service.ts 的 createChatCompletionStream 方法内部：
    return new ReadableStream({
      start(controller) {
        const reader = duckStream.getReader();
        let isFirst = true;

        function pump(): Promise<void> {
          return reader.read().then(({ done, value }) => {
            if (done) {
              // Send final chunk
              const finalChunk: ChatCompletionStreamResponse = {
                id,
                object: "chat.completion.chunk",
                created,
                model: request.model,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: "stop",
                  },
                ],
              };

              const finalData = `data: ${JSON.stringify(finalChunk)}\n\n`;
              const finalDone = `data: [DONE]\n\n`;

              controller.enqueue(new TextEncoder().encode(finalData));
              controller.enqueue(new TextEncoder().encode(finalDone));
              controller.close();
              return;
            }

            if (isFirst) {
              // 1. 发送包含 role 但没有 content 的首包
              const firstChunk: ChatCompletionStreamResponse = {
                id,
                object: "chat.completion.chunk",
                created,
                model: request.model,
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant" },
                    finish_reason: null,
                  },
                ],
              };
              const firstData = `data: ${JSON.stringify(firstChunk)}\n\n`;
              controller.enqueue(new TextEncoder().encode(firstData));
              isFirst = false;
            }

            // 2. 发送带内容的普通包
            const chunk: ChatCompletionStreamResponse = {
              id,
              object: "chat.completion.chunk",
              created,
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: { content: value },
                  finish_reason: null,
                },
              ],
            };

            const data = `data: ${JSON.stringify(chunk)}\n\n`;
            controller.enqueue(new TextEncoder().encode(data));

            return pump();
          });
        }

        return pump();
      },
    });
```

- [ ] **Step 2: 修改流式工具调用方法 `createChatCompletionStreamWithTools`**

调整 Tool Calls 响应结构，发送空内容或只包含 role 的包，然后再发送具体的 tool_calls 数据。

```typescript
// src/openai-service.ts 的 createChatCompletionStreamWithTools 方法内部：
          // Send role first
          const roleChunk: ChatCompletionStreamResponse = {
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
                finish_reason: null,
              },
            ],
          };

          const roleData = `data: ${JSON.stringify(roleChunk)}\n\n`;
          controller.enqueue(new TextEncoder().encode(roleData));

          // Stream tool calls
          const toolCallsChunk: ChatCompletionStreamResponse = {
            id,
            object: "chat.completion.chunk",
            created,
            model: request.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: choice.message.tool_calls,
                },
                finish_reason: null,
              },
            ],
          };

          const toolCallsData = `data: ${JSON.stringify(toolCallsChunk)}\n\n`;
          controller.enqueue(new TextEncoder().encode(toolCallsData));
```

- [ ] **Step 3: 运行测试验证**

由于这调整了首包逻辑，需要保证 `tests/openai-simple.test.ts` 中流式部分的断言正常通过：
`bun test tests/openai-simple.test.ts`

---

### Task 3: 补齐 Error 返回字段

**Files:**
- Modify: `src/server.ts:65-77` (未知接口错误), `src/server.ts:81-102` (异常捕获错误)
- Test: `tests/server.test.ts` (增加针对 param 和 code 字段的断言)

- [ ] **Step 1: 在 server.ts 中补全 Error 返回的 param 和 code 字段**

修改未知接口错误返回：
```typescript
      // 404 for unknown endpoints
      return new Response(
        JSON.stringify({
          error: {
            message: "Not found",
            type: "invalid_request_error",
            param: null,
            code: null,
          },
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
```

修改通用错误返回：
```typescript
      return new Response(
        JSON.stringify({
          error: {
            message: errorMessage,
            type:
              statusCode === 400
                ? "invalid_request_error"
                : "internal_server_error",
            param: null,
            code: null,
          },
        }),
        {
          status: statusCode,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
```

- [ ] **Step 2: 修改 tests/server.test.ts 补充错误返回字段校验**

在 `tests/server.test.ts` 的 `Error Handling` 中添加校验：
```typescript
    it("should return 404 for unknown endpoints", async () => {
      const response = await fetch(`${BASE_URL}/unknown`);
      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error.message).toBe("Not found");
      expect(data.error.type).toBe("invalid_request_error");
      expect(data.error.param).toBeNull();
      expect(data.error.code).toBeNull();
    });
```

- [ ] **Step 3: 运行完整测试套件**

Run: `bun test`
Expected: 所有测试套件全部通过，保证接口格式完美兼容 OpenAI API 规范。
