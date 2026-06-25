import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { OpenAIService } from "../src/openai-service";

process.env.MOCK_DUCK_AI = "true";

const BASE_URL = "http://localhost:3005";
let server: any;

beforeAll(async () => {
  const { spawn } = require("child_process");
  server = spawn("bun", ["run", "src/server.ts"], {
    env: { ...process.env, PORT: "3005", MOCK_DUCK_AI: "true" },
    stdio: "pipe",
  });

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 3000));
});

afterAll(() => {
  if (server) {
    server.kill();
  }
});

describe("OpenAI Responses API Endpoint (/v1/responses)", () => {
  it("should handle basic non-streaming response", async () => {
    const requestBody = {
      model: "gpt-5.4-mini",
      input: [
        { role: "user", content: "Say hello" }
      ]
    };

    const response = await fetch(`${BASE_URL}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    expect(response.status).toBe(200);
    const data = await response.json() as any;

    expect(data.id).toContain("resp_");
    expect(data.object).toBe("response");
    expect(data.status).toBe("completed");
    expect(data.model).toBe("gpt-5.4-mini");

    expect(data.output).toHaveLength(1);
    expect(data.output[0].object).toBe("message");
    expect(data.output[0].role).toBe("assistant");
    expect(Array.isArray(data.output[0].content)).toBe(true);
    expect(data.output[0].content[0].type).toBe("output_text");
    expect(data.output[0].content[0].text).toBe("Hello World");

    expect(data.usage).toBeDefined();
    expect(data.usage.prompt_tokens).toBeGreaterThan(0);
    expect(data.usage.completion_tokens).toBeGreaterThan(0);
    expect(data.usage.total_tokens).toBe(data.usage.prompt_tokens + data.usage.completion_tokens);
  });

  it("should handle streaming response and emit proper event sequence", async () => {
    const requestBody = {
      model: "gpt-5.4-mini",
      input: [
        { role: "user", content: "Say hello" }
      ],
      stream: true
    };

    const response = await fetch(`${BASE_URL}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let events: { event: string; data: any }[] = [];
    let buffer = "";

    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const rawData = line.slice(6).trim();
          try {
            const dataObj = JSON.parse(rawData);
            events.push({ event: currentEvent, data: dataObj });
          } catch (e) {
            // Ignore
          }
          currentEvent = "";
        }
      }
    }

    // Verify events sequence
    expect(events.length).toBeGreaterThanOrEqual(5);

    // Event 1: response.created
    const createdEvent = events.find(e => e.event === "response.created");
    expect(createdEvent).toBeDefined();
    expect(createdEvent!.data.response.object).toBe("response");
    expect(createdEvent!.data.response.status).toBe("in_progress");

    // Event 2: response.output_item.added
    const addedEvent = events.find(e => e.event === "response.output_item.added");
    expect(addedEvent).toBeDefined();
    expect(addedEvent!.data.item.object).toBe("message");
    expect(addedEvent!.data.item.role).toBe("assistant");
    expect(addedEvent!.data.output_index).toBe(0);

    // Event 3: response.output_text.delta
    const deltaEvents = events.filter(e => e.event === "response.output_text.delta");
    expect(deltaEvents.length).toBeGreaterThan(0);
    let reassembledText = "";
    for (const d of deltaEvents) {
      reassembledText += d.data.delta;
      expect(d.data.output_index).toBe(0);
      expect(d.data.content_index).toBe(0);
    }
    expect(reassembledText).toBe("Hello World");

    // Event 4: response.output_item.done
    const itemDoneEvent = events.find(e => e.event === "response.output_item.done");
    expect(itemDoneEvent).toBeDefined();
    expect(itemDoneEvent!.data.item.content[0].text).toBe("Hello World");
    expect(itemDoneEvent!.data.output_index).toBe(0);

    // Event 5: response.done
    const doneEvent = events.find(e => e.event === "response.done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.data.response.status).toBe("completed");
    expect(doneEvent!.data.response.output[0].content[0].text).toBe("Hello World");
    expect(doneEvent!.data.response.usage).toBeDefined();
    expect(doneEvent!.data.response.usage.total_tokens).toBeGreaterThan(0);
  });

  it("should fail validation if input field is missing", async () => {
    const requestBody = {
      model: "gpt-5.4-mini"
    };

    const response = await fetch(`${BASE_URL}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    expect(response.status).toBe(400);
    const data = await response.json() as any;
    expect(data.error.message).toContain("input field is required");
  });

  it("should validate and map developer role and function_call_output in validateResponsesRequest", () => {
    const service = new OpenAIService();
    const req = {
      model: "gpt-4o",
      input: [
        {
          type: "message",
          role: "developer",
          content: "System prompt"
        },
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Hello"
            },
            {
              type: "input_file",
              content: "YmFzZTY0",
              encoding: "base64",
              mimeType: "text/plain",
              filename: "test.txt"
            }
          ]
        },
        {
          type: "function_call_output",
          call_id: "call_123",
          output: "Function result"
        }
      ]
    };
    const validated = service.validateResponsesRequest(req);
    expect(validated.input).toHaveLength(3);

    // Developer should map to system
    expect(validated.input[0].role).toBe("system");
    expect(validated.input[0].content).toBe("System prompt");

    // User message should remain and map content types
    expect(validated.input[1].role).toBe("user");
    expect(Array.isArray(validated.input[1].content)).toBe(true);
    const content = validated.input[1].content as any[];
    expect(content[0].type).toBe("text");
    expect(content[0].text).toBe("Hello");
    expect(content[1].type).toBe("file");
    expect(content[1].filename).toBe("test.txt");

    // Function call output should map to tool
    expect(validated.input[2].role).toBe("tool");
    expect(validated.input[2].tool_call_id).toBe("call_123");
    expect(validated.input[2].content).toBe("Function result");
  });

  it("should handle user reported issue with input_text and output_text content types", async () => {
    const requestBody = {
      model: "gpt-5.4-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "你是什么模型"
            }
          ]
        },
        {
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "gpt-5.4-mini"
            }
          ],
          id: "msg_123"
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "你有什么技能"
            }
          ]
        }
      ],
      stream: true
    };

    const response = await fetch(`${BASE_URL}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const decoder = new TextDecoder();
    let events: { event: string; data: any }[] = [];
    let buffer = "";

    while (true) {
      const { done, value } = await reader!.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let currentEvent = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const rawData = line.slice(6).trim();
          try {
            const dataObj = JSON.parse(rawData);
            events.push({ event: currentEvent, data: dataObj });
          } catch (e) {
            // Ignore
          }
          currentEvent = "";
        }
      }
    }

    expect(events.length).toBeGreaterThanOrEqual(5);
  });
});
