import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import OpenAI from "openai";

process.env.MOCK_DUCK_AI = "true";

const BASE_URL = "http://localhost:3004";
let server: any;
let openai: OpenAI;

beforeAll(async () => {
  const { spawn } = require("child_process");
  server = spawn("bun", ["run", "src/server.ts"], {
    env: { ...process.env, PORT: "3004", MOCK_DUCK_AI: "true" },
    stdio: "pipe",
  });

  await new Promise((resolve) => setTimeout(resolve, 3000));

  openai = new OpenAI({
    baseURL: `${BASE_URL}/v1`,
    apiKey: "dummy-key",
  });
});

afterAll(() => {
  if (server) {
    server.kill();
  }
});

describe("Multimodal Content Support", () => {
  it("should support array content with text and image parts (non-streaming)", async () => {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Say hello" },
            { type: "image_url", image_url: { url: "https://example.com/image.png" } }
          ]
        }
      ],
    });

    expect(completion.object).toBe("chat.completion");
    expect(completion.choices).toHaveLength(1);
    expect(completion.choices[0].message.content).toBe("Hello World");
  });

  it("should support array content (streaming)", async () => {
    const stream = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Count from 1 to 3" }
          ]
        }
      ],
      stream: true,
    });

    let fullContent = "";
    for await (const chunk of stream) {
      if (chunk.choices[0].delta.content) {
        fullContent += chunk.choices[0].delta.content;
      }
    }
    expect(fullContent).toBe("1, 2, 3");
  });

  it("should fail validation with unsupported type field", async () => {
    try {
      await openai.chat.completions.create({
        model: "gpt-5.4-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "unsupported_type" as any, text: "hello" }
            ]
          }
        ],
      });
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.status).toBe(400);
      expect(error.message).toContain("Unsupported content part type");
    }
  });

  it("should fail validation with invalid text part structure", async () => {
    try {
      await openai.chat.completions.create({
        model: "gpt-5.4-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "text" } as any
            ]
          }
        ],
      });
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.status).toBe(400);
      expect(error.message).toContain("Text content parts must have a text field of type string");
    }
  });
});
