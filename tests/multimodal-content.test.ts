import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import OpenAI from "openai";
import { OpenAIService } from "../src/openai-service";

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

  it("should fail validation with unsupported image data URLs", async () => {
    try {
      await openai.chat.completions.create({
        model: "gpt-5.4-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/jpeg;base64,iVBORw0KGgo=" } }
            ]
          }
        ],
      });
      expect(true).toBe(false);
    } catch (error: any) {
      expect(error.status).toBe(400);
      expect(error.message).toContain("Only PNG (image/png) and WebP (image/webp) images are supported");
    }
  });

  it("should support WebP images in content parts", async () => {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image" },
            { type: "image_url", image_url: { url: "data:image/webp;base64,UklGRh5hAABXRUJQVlA4WAoAAAAgAAAA/wEAHwEASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggMF8AAPB/AZ0BKgACIAE+MRiaWkflVmr2HGX0ojfhgvsh30AelKr7dva4IBuxm8TcoX4EU2i+V9qfPHjBt85/+VS9qoNwUOJyfxYKIIkOzyE1nFQWRLGzFJAAAA" } }
          ]
        }
      ],
    });

    expect(completion.object).toBe("chat.completion");
    expect(completion.choices).toHaveLength(1);
    expect(completion.choices[0].message.content).toBe("Hello World");
  });

  it("should support file upload content parts and assistant parts payload", async () => {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "assistant",
          content: "你好。如果想继续排查，回复 1。",
          parts: [
            {
              type: "reasoning",
              id: "rs_01",
              state: "done",
              summaryText: ["Thinking..."]
            }
          ]
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Some normal query" },
            {
              type: "file",
              content: "U2F5IGhlbGxv", // Base64 encoding of "Say hello"
              encoding: "base64",
              mimeType: "text/plain",
              filename: "hello.txt"
            }
          ]
        }
      ],
    });

    expect(completion.object).toBe("chat.completion");
    expect(completion.choices).toHaveLength(1);
    expect(completion.choices[0].message.content).toBe("Hello World");
  });

  it("should support reasoning_effort option payload", async () => {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "Say hello" }],
      // Use standard OpenAI reasoning_effort field
      reasoning_effort: "medium"
    } as any);

    expect(completion.object).toBe("chat.completion");
    expect(completion.choices[0].message.content).toBe("Hello World");
  });

  it("should transform image_url data URL to image part in transformToDuckAIRequest", () => {
    const service = new OpenAIService();
    const req = {
      model: "gpt-4o",
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Describe this image" },
            {
              type: "image_url" as const,
              image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }
            }
          ]
        }
      ]
    };
    const transformed = (service as any).transformToDuckAIRequest(req);
    expect(transformed.messages).toHaveLength(1);
    const msg = transformed.messages[0];
    expect(msg.role).toBe("user");
    expect(Array.isArray(msg.content)).toBe(true);
    expect(msg.content[0]).toEqual({ type: "text", text: "Describe this image" });
    expect(msg.content[1].type).toBe("image");
    expect(msg.content[1].mimeType).toBe("image/png");
    expect(msg.content[1].image).toBe("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");
  });

  it("should prepend system instructions as a TextPart when first user message content is an array", () => {
    const service = new OpenAIService();
    const req = {
      model: "gpt-4o",
      messages: [
        { role: "system" as const, content: "You are a helpful assistant." },
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Hello" }
          ]
        }
      ]
    };
    const transformed = (service as any).transformToDuckAIRequest(req);
    expect(transformed.messages).toHaveLength(1);
    const msg = transformed.messages[0];
    expect(msg.role).toBe("user");
    expect(Array.isArray(msg.content)).toBe(true);
    expect(msg.content[0]).toEqual({
      type: "text",
      text: "[System Instructions]\nYou are a helpful assistant.\n\n"
    });
    expect(msg.content[1]).toEqual({
      type: "text",
      text: "Hello"
    });
  });

  it("should preserve assistant parts in transformToDuckAIRequest", () => {
    const service = new OpenAIService();
    const req = {
      model: "gpt-4o",
      messages: [
        {
          role: "assistant" as const,
          content: "Hello",
          parts: [
            {
              type: "reasoning",
              id: "rs_01",
              state: "done",
              summaryText: ["Thinking..."]
            }
          ]
        }
      ]
    };
    const transformed = (service as any).transformToDuckAIRequest(req);
    expect(transformed.messages).toHaveLength(1);
    const msg = transformed.messages[0];
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("Hello");
    expect(msg.parts).toEqual([
      {
        type: "reasoning",
        id: "rs_01",
        state: "done",
        summaryText: ["Thinking..."]
      }
    ]);
  });

  it("should support nested file object content parts in chat completions", async () => {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Process this file:" },
            {
              type: "file",
              file: {
                filename: "nested-file.txt",
                file_data: "data:text/plain;base64,SGVsbG8gRnJvbSBOZXN0ZWQgRmlsZQ==" // "Hello From Nested File"
              }
            }
          ]
        }
      ]
    });

    expect(completion.object).toBe("chat.completion");
    expect(completion.choices).toHaveLength(1);
    expect(completion.choices[0].message.content).toBe("This is a mock response from DuckAI server. Testing was successful!");
  });

  it("should transform nested file object correctly in transformToDuckAIRequest", () => {
    const service = new OpenAIService();
    const req = {
      model: "gpt-4o",
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Process this" },
            {
              type: "file" as const,
              file: {
                filename: "document.txt",
                file_data: "data:text/plain;base64,aGVsbG8gd29ybGQ=" // "hello world"
              }
            }
          ]
        }
      ]
    };
    const transformed = (service as any).transformToDuckAIRequest(req);
    expect(transformed.messages).toHaveLength(1);
    const msg = transformed.messages[0];
    expect(msg.role).toBe("user");
    expect(Array.isArray(msg.content)).toBe(true);
    expect(msg.content[0]).toEqual({ type: "text", text: "Process this" });
    expect(msg.content[1].type).toBe("text");
    expect(msg.content[1].text).toContain("[Uploaded File: document.txt (Type: text/plain)]");
    expect(msg.content[1].text).toContain("hello world");
  });
});
