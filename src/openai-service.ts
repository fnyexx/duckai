import { DuckAI } from "./duckai";
import { ToolService } from "./tool-service";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionStreamResponse,
  ChatCompletionMessage,
  ModelsResponse,
  Model,
  DuckAIRequest,
  DuckAIMessage,
  ContentPart,
  TextPart,
  ToolDefinition,
  ToolCall,
  ResponsesRequest,
  ResponsesResponse,
  ResponseItem,
} from "./types";

export class OpenAIService {
  private duckAI: DuckAI;
  private toolService: ToolService;
  private availableFunctions: Record<string, Function>;

  constructor() {
    this.duckAI = new DuckAI();
    this.toolService = new ToolService();
    this.availableFunctions = this.initializeBuiltInFunctions();
  }

  private initializeBuiltInFunctions(): Record<string, Function> {
    return {
      // Example built-in functions - users can extend this
      get_current_time: () => new Date().toISOString(),
      calculate: (args: { expression: string }) => {
        try {
          // Simple calculator - in production, use a proper math parser
          const result = Function(
            `"use strict"; return (${args.expression})`
          )();
          return { result };
        } catch (error) {
          return { error: "Invalid expression" };
        }
      },
      get_weather: (args: { location: string }) => {
        // Mock weather function
        return {
          location: args.location,
          temperature: Math.floor(Math.random() * 30) + 10,
          condition: ["sunny", "cloudy", "rainy"][
            Math.floor(Math.random() * 3)
          ],
          note: "This is a mock weather function for demonstration",
        };
      },
    };
  }

  registerFunction(name: string, func: Function): void {
    this.availableFunctions[name] = func;
  }

  private generateId(): string {
    return `chatcmpl-${Math.random().toString(36).substring(2, 15)}`;
  }

  private getCurrentTimestamp(): number {
    return Math.floor(Date.now() / 1000);
  }

  private estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  private extractTextFromContent(
    content: string | ContentPart[] | null | undefined
  ): string {
    if (!content) {
      return "";
    }
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (part.type === "text") {
            return part.text;
          }
          if (part.type === "file") {
            let fileContentText = "";
            try {
              if (part.encoding === "base64") {
                // Decode Base64 encoded file content
                fileContentText = Buffer.from(part.content, "base64").toString("utf-8");
              } else {
                fileContentText = part.content;
              }
            } catch (err) {
              fileContentText = `[Error decoding file content: ${err instanceof Error ? err.message : String(err)}]`;
            }
            return `[Uploaded File: ${part.filename} (Type: ${part.mimeType})]\n--- START OF FILE CONTENT ---\n${fileContentText}\n--- END OF FILE CONTENT ---`;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }

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

    const supportedModels = ["gpt-5.4-mini", "gpt-5.4-nano", "claude-haiku-4-5"];

    const requestedModel = request.model || "gpt-5.4-mini";
    let targetModel = modelMap[requestedModel] || requestedModel;

    // Fuzzy matching fallback
    if (!supportedModels.includes(targetModel)) {
      const lowerModel = targetModel.toLowerCase();
      if (lowerModel.includes("claude")) {
        targetModel = "claude-haiku-4-5";
      } else if (lowerModel.includes("nano")) {
        targetModel = "gpt-5.4-nano";
      } else {
        targetModel = "gpt-5.4-mini";
      }
    }

    // 1. Extract all system messages and combine them
    const systemMessages = request.messages.filter((m) => m.role === "system");
    const systemPrompt = systemMessages
      .map((m) => this.extractTextFromContent(m.content))
      .filter(Boolean)
      .join("\n");

    let processedMessages = [...request.messages];

    if (systemPrompt) {
      // 2. Find the first user message to inject system instructions
      const firstUserMsgIndex = processedMessages.findIndex((m) => m.role === "user");

      if (firstUserMsgIndex !== -1) {
        const userMsg = { ...processedMessages[firstUserMsgIndex] };
        if (Array.isArray(userMsg.content)) {
          userMsg.content = [
            { type: "text", text: `[System Instructions]\n${systemPrompt}\n\n` },
            ...userMsg.content
          ];
        } else {
          const userContent = this.extractTextFromContent(userMsg.content);
          userMsg.content = `[System Instructions]\n${systemPrompt}\n\n${userContent}`;
        }
        processedMessages[firstUserMsgIndex] = userMsg;

        // Filter out original system messages
        processedMessages = processedMessages.filter((m) => m.role !== "system");
      } else {
        // No user messages found, convert first system message into a user message
        const firstSystemMsgIndex = processedMessages.findIndex((m) => m.role === "system");
        if (firstSystemMsgIndex !== -1) {
          const firstSys = { ...processedMessages[firstSystemMsgIndex] };
          firstSys.role = "user" as const;
          firstSys.content = `[System Instructions]\n${systemPrompt}`;

          processedMessages = processedMessages.filter((m, idx) => m.role !== "system" || idx === firstSystemMsgIndex);
          processedMessages[0] = firstSys;
        }
      }
    } else {
      // Filter out system messages even if systemPrompt is empty
      processedMessages = processedMessages.filter((m) => m.role !== "system");
    }

    const duckAIMessages: DuckAIMessage[] = processedMessages.map((m) => {
      const msg: DuckAIMessage = {
        role: m.role,
        content: null,
      };

      if (Array.isArray(m.content)) {
        msg.content = m.content.map((part) => {
          if (part.type === "text") {
            return {
              type: "text",
              text: part.text,
            };
          }
          if (part.type === "file") {
            return {
              type: "file",
              content: part.content,
              encoding: part.encoding,
              mimeType: part.mimeType,
              filename: part.filename,
            };
          }
          if (part.type === "image_url") {
            const url = part.image_url.url;
            if (url.startsWith("data:")) {
              const match = url.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                const mimeType = match[1];
                const base64Data = match[2];
                let ext = mimeType.split("/")[1] || "png";
                if (ext.includes("+")) {
                  ext = ext.split("+")[0];
                }
                return {
                  type: "file",
                  content: base64Data,
                  encoding: "base64",
                  mimeType: mimeType,
                  filename: `image_${Date.now()}.${ext}`,
                };
              }
            }
            // Fallback for non-data URLs
            return {
              type: "text",
              text: `[Image URL: ${url}]`,
            };
          }
          return part;
        }) as any;
      } else {
        msg.content = m.content;
      }

      if (m.name) msg.name = m.name;
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.parts) msg.parts = m.parts;

      return msg;
    });

    return {
      model: targetModel,
      messages: duckAIMessages,
      reasoningEffort: request.reasoning_effort,
    };
  }

  async createChatCompletion(
    request: ChatCompletionRequest
  ): Promise<ChatCompletionResponse> {
    // Check if this request involves function calling
    if (
      this.toolService.shouldUseFunctionCalling(
        request.tools,
        request.tool_choice
      )
    ) {
      return this.createChatCompletionWithTools(request);
    }

    const duckAIRequest = this.transformToDuckAIRequest(request);
    const response = await this.duckAI.chat(duckAIRequest);

    const id = this.generateId();
    const created = this.getCurrentTimestamp();

    // Calculate token usage
    const promptText = request.messages.map((m) => this.extractTextFromContent(m.content)).join(" ");
    const promptTokens = this.estimateTokens(promptText);
    const completionTokens = this.estimateTokens(response);

    return {
      id,
      object: "chat.completion",
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  private async createChatCompletionWithTools(
    request: ChatCompletionRequest
  ): Promise<ChatCompletionResponse> {
    const id = this.generateId();
    const created = this.getCurrentTimestamp();

    // Validate tools
    if (request.tools) {
      const validation = this.toolService.validateTools(request.tools);
      if (!validation.valid) {
        throw new Error(`Invalid tools: ${validation.errors.join(", ")}`);
      }
    }

    // Create a modified request with tool instructions
    const modifiedMessages = [...request.messages];

    // Add tool instructions as user message (DuckAI doesn't support system messages)
    if (request.tools && request.tools.length > 0) {
      const toolPrompt = this.toolService.generateToolSystemPrompt(
        request.tools,
        request.tool_choice
      );
      modifiedMessages.unshift({
        role: "user",
        content: `[SYSTEM INSTRUCTIONS] ${toolPrompt}

Please follow these instructions when responding to the following user message.`,
      });
    }

    const duckAIRequest = this.transformToDuckAIRequest({
      ...request,
      messages: modifiedMessages,
    });

    const response = await this.duckAI.chat(duckAIRequest);

    // Check if the response contains function calls
    if (this.toolService.detectFunctionCalls(response)) {
      const toolCalls = this.toolService.extractFunctionCalls(response);

      if (toolCalls.length > 0) {
        // Calculate token usage
        const promptText = modifiedMessages
          .map((m) => this.extractTextFromContent(m.content))
          .join(" ");
        const promptTokens = this.estimateTokens(promptText);
        const completionTokens = this.estimateTokens(response);

        return {
          id,
          object: "chat.completion",
          created,
          model: request.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: toolCalls,
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        };
      }
    }

    // No function calls detected
    // If tool_choice is "required" or specific function, we need to force a function call
    if (
      (request.tool_choice === "required" ||
        (typeof request.tool_choice === "object" &&
          request.tool_choice.type === "function")) &&
      request.tools &&
      request.tools.length > 0
    ) {
      // Get user message for argument extraction
      const userMessage = request.messages[request.messages.length - 1];
      const userContent = this.extractTextFromContent(userMessage.content);

      // Determine which function to call
      let functionToCall: string;

      // If specific function is requested, use that
      if (
        typeof request.tool_choice === "object" &&
        request.tool_choice.type === "function"
      ) {
        functionToCall = request.tool_choice.function.name;
      } else {
        // Try to infer which function to call based on the user's request
        // Simple heuristics to choose appropriate function
        functionToCall = request.tools[0].function.name; // Default to first function

        if (userContent.toLowerCase().includes("time")) {
          const timeFunction = request.tools.find(
            (t) => t.function.name === "get_current_time"
          );
          if (timeFunction) functionToCall = timeFunction.function.name;
        } else if (
          userContent.toLowerCase().includes("calculate") ||
          /\d+\s*[+\-*/]\s*\d+/.test(userContent)
        ) {
          const calcFunction = request.tools.find(
            (t) => t.function.name === "calculate"
          );
          if (calcFunction) functionToCall = calcFunction.function.name;
        } else if (userContent.toLowerCase().includes("weather")) {
          const weatherFunction = request.tools.find(
            (t) => t.function.name === "get_weather"
          );
          if (weatherFunction) functionToCall = weatherFunction.function.name;
        }
      }

      // Generate appropriate arguments based on function
      let args = "{}";
      if (functionToCall === "calculate") {
        const mathMatch = userContent.match(/(\d+\s*[+\-*/]\s*\d+)/);
        if (mathMatch) {
          args = JSON.stringify({ expression: mathMatch[1] });
        }
      } else if (functionToCall === "get_weather") {
        // Try to extract location from user message
        const locationMatch = userContent.match(
          /(?:in|for|at)\s+([A-Za-z\s,]+)/i
        );
        if (locationMatch) {
          args = JSON.stringify({ location: locationMatch[1].trim() });
        }
      }

      const forcedToolCall: ToolCall = {
        id: `call_${Date.now()}`,
        type: "function",
        function: {
          name: functionToCall,
          arguments: args,
        },
      };

      const promptText = modifiedMessages.map((m) => this.extractTextFromContent(m.content)).join(" ");
      const promptTokens = this.estimateTokens(promptText);
      const completionTokens = this.estimateTokens(
        JSON.stringify(forcedToolCall)
      );

      return {
        id,
        object: "chat.completion",
        created,
        model: request.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [forcedToolCall],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    }

    // No function calls detected, return normal response
    const promptText = modifiedMessages.map((m) => this.extractTextFromContent(m.content)).join(" ");
    const promptTokens = this.estimateTokens(promptText);
    const completionTokens = this.estimateTokens(response);

    return {
      id,
      object: "chat.completion",
      created,
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  async createChatCompletionStream(
    request: ChatCompletionRequest
  ): Promise<ReadableStream<Uint8Array>> {
    // Check if this request involves function calling
    if (
      this.toolService.shouldUseFunctionCalling(
        request.tools,
        request.tool_choice
      )
    ) {
      return this.createChatCompletionStreamWithTools(request);
    }

    const duckAIRequest = this.transformToDuckAIRequest(request);
    const duckStream = await this.duckAI.chatStream(duckAIRequest);

    const id = this.generateId();
    const created = this.getCurrentTimestamp();

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
              // 1. Send first chunk containing only role
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

            // 2. Send chunk containing content
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
          }).catch((err) => {
            console.error("Stream reader error in OpenAI Service:", err);
            const errResponse = {
              error: {
                message: err instanceof Error ? err.message : "Stream read error",
                type: "internal_server_error",
                param: null,
                code: null
              }
            };
            const errData = `data: ${JSON.stringify(errResponse)}\n\n`;
            controller.enqueue(new TextEncoder().encode(errData));
            controller.close();
          });
        }

        return pump();
      },
    });
  }

  private async createChatCompletionStreamWithTools(
    request: ChatCompletionRequest
  ): Promise<ReadableStream<Uint8Array>> {
    // For tools, we need to collect the full response first to parse function calls
    // This is a limitation of the "trick" approach - streaming with tools is complex
    const completion = await this.createChatCompletionWithTools(request);

    const id = completion.id;
    const created = completion.created;
    const self = this;

    return new ReadableStream({
      start(controller) {
        const choice = completion.choices[0];

        if (choice.message.tool_calls) {
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
                finish_reason: "tool_calls",
              },
            ],
          };

          const finalData = `data: ${JSON.stringify(finalChunk)}\n\n`;
          const finalDone = `data: [DONE]\n\n`;

          controller.enqueue(new TextEncoder().encode(finalData));
          controller.enqueue(new TextEncoder().encode(finalDone));
        } else {
          // Stream regular content
          const content = self.extractTextFromContent(choice.message.content);

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

          // Stream content in chunks
          const chunkSize = 10;
          for (let i = 0; i < content.length; i += chunkSize) {
            const contentChunk = content.slice(i, i + chunkSize);

            const chunk: ChatCompletionStreamResponse = {
              id,
              object: "chat.completion.chunk",
              created,
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: { content: contentChunk },
                  finish_reason: null,
                },
              ],
            };

            const data = `data: ${JSON.stringify(chunk)}\n\n`;
            controller.enqueue(new TextEncoder().encode(data));
          }

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
        }

        controller.close();
      },
    });
  }

  getModels(): ModelsResponse {
    const models = this.duckAI.getAvailableModels();
    const created = this.getCurrentTimestamp();

    const modelData: Model[] = models.map((modelId) => ({
      id: modelId,
      object: "model",
      created,
      owned_by: "duckai",
    }));

    return {
      object: "list",
      data: modelData,
    };
  }

  validateRequest(request: any): ChatCompletionRequest {
    if (!request.messages || !Array.isArray(request.messages)) {
      throw new Error("messages field is required and must be an array");
    }

    if (request.messages.length === 0) {
      throw new Error("messages array cannot be empty");
    }

    for (const message of request.messages) {
      if (
        !message.role ||
        !["system", "user", "assistant", "tool"].includes(message.role)
      ) {
        throw new Error(
          "Each message must have a valid role (system, user, assistant, or tool)"
        );
      }

      // Tool messages have different validation rules
      if (message.role === "tool") {
        if (!message.tool_call_id) {
          throw new Error("Tool messages must have a tool_call_id");
        }
        if (typeof message.content !== "string") {
          throw new Error("Tool messages must have content as a string");
        }
      } else {
        if (message.content === undefined) {
          throw new Error("Each message must have content");
        }

        if (
          message.content !== null &&
          typeof message.content !== "string" &&
          !Array.isArray(message.content)
        ) {
          throw new Error("Each message must have content as a string, array, or null");
        }

        if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (typeof part !== "object" || part === null) {
              throw new Error("Content parts must be objects");
            }
            if (!("type" in part)) {
              throw new Error("Each content part must have a type");
            }
            if (part.type !== "text" && part.type !== "image_url" && part.type !== "file") {
              throw new Error(`Unsupported content part type: ${part.type}`);
            }
            if (part.type === "text") {
              if (typeof part.text !== "string") {
                throw new Error("Text content parts must have a text field of type string");
              }
            } else if (part.type === "image_url") {
              if (
                typeof part.image_url !== "object" ||
                part.image_url === null ||
                typeof part.image_url.url !== "string"
              ) {
                throw new Error("Image content parts must have an image_url object with a url field");
              }
            } else if (part.type === "file") {
              if (
                typeof part.content !== "string" ||
                typeof part.encoding !== "string" ||
                typeof part.mimeType !== "string" ||
                typeof part.filename !== "string"
              ) {
                throw new Error("File content parts must have content, encoding, mimeType, and filename as strings");
              }
            }
          }
        }
      }
    }

    // Validate tools if provided
    if (request.tools) {
      const validation = this.toolService.validateTools(request.tools);
      if (!validation.valid) {
        throw new Error(`Invalid tools: ${validation.errors.join(", ")}`);
      }
    }

    return {
      model: request.model || "gpt-5.4-mini",
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      stream: request.stream || false,
      top_p: request.top_p,
      frequency_penalty: request.frequency_penalty,
      presence_penalty: request.presence_penalty,
      stop: request.stop,
      tools: request.tools,
      tool_choice: request.tool_choice,
      reasoning_effort: request.reasoning_effort,
    };
  }

  async executeToolCall(toolCall: ToolCall): Promise<string> {
    return this.toolService.executeFunctionCall(
      toolCall,
      this.availableFunctions
    );
  }

  /**
   * Get current rate limit status from DuckAI
   */
  getRateLimitStatus() {
    return this.duckAI.getRateLimitStatus();
  }

  validateResponsesRequest(request: any): ResponsesRequest {
    if (!request.input || !Array.isArray(request.input)) {
      throw new Error("input field is required and must be an array");
    }

    const fakeRequest = {
      ...request,
      messages: request.input,
    };
    const validatedFake = this.validateRequest(fakeRequest);

    return {
      model: validatedFake.model,
      input: validatedFake.messages,
      temperature: validatedFake.temperature,
      max_tokens: validatedFake.max_tokens,
      stream: validatedFake.stream,
      top_p: validatedFake.top_p,
      frequency_penalty: validatedFake.frequency_penalty,
      presence_penalty: validatedFake.presence_penalty,
      stop: validatedFake.stop,
      tools: validatedFake.tools,
      tool_choice: validatedFake.tool_choice,
      reasoning_effort: validatedFake.reasoning_effort,
    };
  }

  async createResponse(
    request: ResponsesRequest
  ): Promise<ResponsesResponse> {
    const chatRequest: ChatCompletionRequest = {
      model: request.model,
      messages: request.input,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      stream: false,
      top_p: request.top_p,
      frequency_penalty: request.frequency_penalty,
      presence_penalty: request.presence_penalty,
      stop: request.stop,
      tools: request.tools,
      tool_choice: request.tool_choice,
      reasoning_effort: request.reasoning_effort,
    };

    const completion = await this.createChatCompletion(chatRequest);
    const responseId = completion.id.replace("chatcmpl-", "resp_");
    const output: ResponseItem[] = completion.choices.map((choice) => {
      const msgId = `msg_${Math.random().toString(36).substring(2, 15)}`;

      let contentParts: ContentPart[] = [];
      if (choice.message.content === null) {
        contentParts = [];
      } else if (typeof choice.message.content === "string") {
        contentParts = [{ type: "text", text: choice.message.content }];
      } else if (Array.isArray(choice.message.content)) {
        contentParts = choice.message.content;
      }

      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          contentParts.push({
            type: "function_call",
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }

      return {
        id: msgId,
        object: "message" as const,
        role: choice.message.role as any,
        content: contentParts,
      };
    });

    return {
      id: responseId,
      object: "response" as const,
      model: completion.model,
      status: "completed",
      output,
      usage: completion.usage,
    };
  }

  async createResponseStream(
    request: ResponsesRequest
  ): Promise<ReadableStream<Uint8Array>> {
    const chatRequest: ChatCompletionRequest = {
      model: request.model,
      messages: request.input,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      stream: true,
      top_p: request.top_p,
      frequency_penalty: request.frequency_penalty,
      presence_penalty: request.presence_penalty,
      stop: request.stop,
      tools: request.tools,
      tool_choice: request.tool_choice,
      reasoning_effort: request.reasoning_effort,
    };

    const chatStream = await this.createChatCompletionStream(chatRequest);
    const responseId = `resp_${Math.random().toString(36).substring(2, 15)}`;
    const assistantItemId = `msg_${Math.random().toString(36).substring(2, 15)}`;
    const self = this;

    return new ReadableStream({
      async start(controller) {
        const reader = chatStream.getReader();
        const encoder = new TextEncoder();
        let accumulatedContent = "";
        let accumulatedToolCalls: ToolCall[] = [];

        const sendEvent = (eventName: string, data: any) => {
          const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        };

        sendEvent("response.created", {
          id: responseId,
          object: "response",
          model: request.model,
          status: "in_progress",
          output: []
        });

        sendEvent("response.output_item.added", {
          response_id: responseId,
          item: {
            id: assistantItemId,
            object: "message",
            role: "assistant",
            content: []
          }
        });

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const textChunk = new TextDecoder().decode(value);
            const lines = textChunk.split("\n");
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const rawData = line.slice(6).trim();
                if (rawData === "[DONE]") continue;

                try {
                  const chunkObj = JSON.parse(rawData);
                  const deltaContent = chunkObj.choices?.[0]?.delta?.content;
                  if (deltaContent) {
                    accumulatedContent += deltaContent;

                    sendEvent("response.output_item.delta", {
                      response_id: responseId,
                      item_id: assistantItemId,
                      part_index: 0,
                      delta: deltaContent
                    });
                  }

                  const deltaToolCalls = chunkObj.choices?.[0]?.delta?.tool_calls;
                  if (deltaToolCalls) {
                    accumulatedToolCalls.push(...deltaToolCalls);
                  }
                } catch (e) {
                  // Ignore JSON parse errors
                }
              }
            }
          }

          let finalContentParts: ContentPart[] = [];
          if (accumulatedContent) {
            finalContentParts.push({
              type: "text",
              text: accumulatedContent
            });
          }
          if (accumulatedToolCalls.length > 0) {
            for (const tc of accumulatedToolCalls) {
              finalContentParts.push({
                type: "function_call",
                id: tc.id,
                name: tc.function.name,
                arguments: tc.function.arguments
              });
            }
          }

          sendEvent("response.output_item.done", {
            response_id: responseId,
            item: {
              id: assistantItemId,
              object: "message",
              role: "assistant",
              content: finalContentParts
            }
          });

          const promptText = request.input
            .map((m) => self.extractTextFromContent(m.content))
            .join(" ");
          const promptTokens = self.estimateTokens(promptText);
          const completionTokens = self.estimateTokens(accumulatedContent || JSON.stringify(accumulatedToolCalls));

          sendEvent("response.done", {
            id: responseId,
            object: "response",
            model: request.model,
            status: "completed",
            output: [
              {
                id: assistantItemId,
                object: "message",
                role: "assistant",
                content: finalContentParts
              }
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens
            }
          });
        } catch (err) {
          console.error("Responses stream error:", err);
          sendEvent("response.done", {
            id: responseId,
            object: "response",
            model: request.model,
            status: "failed",
            output: [],
            error: {
              message: err instanceof Error ? err.message : String(err)
            }
          });
        } finally {
          controller.close();
        }
      }
    });
  }
}
