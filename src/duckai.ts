import UserAgent from "user-agents";
import { JSDOM } from "jsdom";
import { RateLimitStore } from "./rate-limit-store";
import { SharedRateLimitMonitor } from "./shared-rate-limit-monitor";
import { gotScraping } from "got-scraping";
import type {
  ChatCompletionMessage,
  VQDResponse,
  DuckAIRequest,
} from "./types";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

// Rate limiting tracking with sliding window
interface RateLimitInfo {
  requestTimestamps: number[]; // Array of request timestamps for sliding window
  lastRequestTime: number;
  isLimited: boolean;
  retryAfter?: number;
}

export class DuckAI {
  private entryScriptName = "/dist/duckai-dist/entry.duckai.28d59466fe10c017873c.js";
  private rateLimitInfo: RateLimitInfo = {
    requestTimestamps: [],
    lastRequestTime: 0,
    isLimited: false,
  };
  private rateLimitStore: RateLimitStore;
  private rateLimitMonitor: SharedRateLimitMonitor;

  // Conservative rate limiting - adjust based on observed limits
  private readonly MAX_REQUESTS_PER_MINUTE = 20;
  private readonly WINDOW_SIZE_MS = 60 * 1000; // 1 minute
  private readonly MIN_REQUEST_INTERVAL_MS = 1000; // 1 second between requests

  constructor() {
    this.rateLimitStore = new RateLimitStore();
    this.rateLimitMonitor = new SharedRateLimitMonitor();
    this.loadRateLimitFromStore();
  }

  /**
   * Helper to generate a simulated response from DuckAI for local testing
   */
  private async getMockResponse(request: DuckAIRequest): Promise<string> {
    const lastMessage = request.messages[request.messages.length - 1];
    const userContent = lastMessage?.content || "";

    // Check if the request contains tool instructions (pushed as a system/user instruction prompt)
    const systemPromptMessage = request.messages.find(
      (m) => m.role === "user" && m.content?.includes("[SYSTEM INSTRUCTIONS]")
    );
    const hasToolsInstruction = !!systemPromptMessage;

    if (hasToolsInstruction) {
      const systemContent = systemPromptMessage.content || "";
      // If the prompt requires function call for time
      if (userContent.toLowerCase().includes("time") || systemContent.includes("get_current_time")) {
        return JSON.stringify({
          tool_calls: [
            {
              id: "call_mock_time",
              type: "function",
              function: {
                name: "get_current_time",
                arguments: "{}"
              }
            }
          ]
        });
      }

      // If the prompt requires function call for math
      if (userContent.toLowerCase().includes("calculate") || systemContent.includes("calculate") || /\d+\s*[+\-*/]\s*\d+/.test(userContent)) {
        const mathMatch = userContent.match(/(\d+\s*[+\-*/]\s*\d+)/);
        const expression = mathMatch ? mathMatch[1] : "15 + 27";
        return JSON.stringify({
          tool_calls: [
            {
              id: "call_mock_calc",
              type: "function",
              function: {
                name: "calculate",
                arguments: JSON.stringify({ expression })
              }
            }
          ]
        });
      }

      // If the prompt requires function call for weather
      if (userContent.toLowerCase().includes("weather") || systemContent.includes("get_weather")) {
        const locationMatch = userContent.match(/(?:in|for|at)\s+([A-Za-z\s,]+)/i);
        const location = locationMatch ? locationMatch[1].trim() : "Paris";
        return JSON.stringify({
          tool_calls: [
            {
              id: "call_mock_weather",
              type: "function",
              function: {
                name: "get_weather",
                arguments: JSON.stringify({ location })
              }
            }
          ]
        });
      }
    }

    // Direct response mock mapping
    if (userContent.includes("Say hello") || userContent.includes("Say 'Hello World'")) {
      return "Hello World";
    }
    if (userContent.includes("Count from 1 to 3")) {
      return "1, 2, 3";
    }
    if (userContent.includes("Count from 1 to 5")) {
      return "1\n2\n3\n4\n5";
    }
    if (userContent.toLowerCase().includes("joke")) {
      return "Why don't scientists trust atoms? Because they make up everything!";
    }
    if (userContent.toLowerCase().includes("poem")) {
      return "Roses are red,\nViolets are blue,\nTesting is fun,\nAnd Mocking is too!";
    }

    return "This is a mock response from DuckAI server. Testing was successful!";
  }

  /**
   * Clean old timestamps outside the sliding window
   */
  private cleanOldTimestamps(): void {
    const now = Date.now();
    const cutoff = now - this.WINDOW_SIZE_MS;
    this.rateLimitInfo.requestTimestamps =
      this.rateLimitInfo.requestTimestamps.filter(
        (timestamp) => timestamp > cutoff
      );
  }

  /**
   * Get current request count in sliding window
   */
  private getCurrentRequestCount(): number {
    this.cleanOldTimestamps();
    return this.rateLimitInfo.requestTimestamps.length;
  }

  /**
   * Load rate limit data from shared store
   */
  private loadRateLimitFromStore(): void {
    const stored = this.rateLimitStore.read();
    if (stored) {
      // Convert old format to new sliding window format if needed
      const storedAny = stored as any;
      if ("requestCount" in storedAny && "windowStart" in storedAny) {
        // Old format - convert to new format (start fresh)
        this.rateLimitInfo = {
          requestTimestamps: [],
          lastRequestTime: storedAny.lastRequestTime || 0,
          isLimited: storedAny.isLimited || false,
          retryAfter: storedAny.retryAfter,
        };
      } else {
        // New format
        this.rateLimitInfo = {
          requestTimestamps: storedAny.requestTimestamps || [],
          lastRequestTime: storedAny.lastRequestTime || 0,
          isLimited: storedAny.isLimited || false,
          retryAfter: storedAny.retryAfter,
        };
      }
      // Clean old timestamps after loading
      this.cleanOldTimestamps();
    }
  }

  /**
   * Save rate limit data to shared store
   */
  private saveRateLimitToStore(): void {
    this.cleanOldTimestamps();
    this.rateLimitStore.write({
      requestTimestamps: this.rateLimitInfo.requestTimestamps,
      lastRequestTime: this.rateLimitInfo.lastRequestTime,
      isLimited: this.rateLimitInfo.isLimited,
      retryAfter: this.rateLimitInfo.retryAfter,
    } as any);
  }

  /**
   * Get current rate limit status
   */
  getRateLimitStatus(): {
    requestsInCurrentWindow: number;
    maxRequestsPerMinute: number;
    timeUntilWindowReset: number;
    isCurrentlyLimited: boolean;
    recommendedWaitTime: number;
  } {
    // Load latest data from store first
    this.loadRateLimitFromStore();

    const now = Date.now();
    const currentRequestCount = this.getCurrentRequestCount();

    // For sliding window, there's no fixed reset time
    // The "reset" happens continuously as old requests fall out of the window
    const oldestTimestamp = this.rateLimitInfo.requestTimestamps[0];
    const timeUntilReset = oldestTimestamp
      ? Math.max(0, oldestTimestamp + this.WINDOW_SIZE_MS - now)
      : 0;

    const timeSinceLastRequest = now - this.rateLimitInfo.lastRequestTime;
    const recommendedWait = Math.max(
      0,
      this.MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest
    );

    return {
      requestsInCurrentWindow: currentRequestCount,
      maxRequestsPerMinute: this.MAX_REQUESTS_PER_MINUTE,
      timeUntilWindowReset: timeUntilReset,
      isCurrentlyLimited: this.rateLimitInfo.isLimited,
      recommendedWaitTime: recommendedWait,
    };
  }

  /**
   * Check if we should wait before making a request
   */
  private shouldWaitBeforeRequest(): { shouldWait: boolean; waitTime: number } {
    // Load latest data from store first
    this.loadRateLimitFromStore();

    const now = Date.now();
    const currentRequestCount = this.getCurrentRequestCount();

    // Check if we're hitting the rate limit
    if (currentRequestCount >= this.MAX_REQUESTS_PER_MINUTE) {
      // Find the oldest request timestamp
      const oldestTimestamp = this.rateLimitInfo.requestTimestamps[0];
      if (oldestTimestamp) {
        // Wait until the oldest request falls out of the window
        const waitTime = oldestTimestamp + this.WINDOW_SIZE_MS - now + 100; // +100ms buffer
        return { shouldWait: true, waitTime: Math.max(0, waitTime) };
      }
    }

    // Check minimum interval between requests
    const timeSinceLastRequest = now - this.rateLimitInfo.lastRequestTime;
    if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL_MS) {
      const waitTime = this.MIN_REQUEST_INTERVAL_MS - timeSinceLastRequest;
      return { shouldWait: true, waitTime };
    }

    return { shouldWait: false, waitTime: 0 };
  }

  /**
   * Wait if necessary before making a request
   */
  private async waitIfNeeded(): Promise<void> {
    const { shouldWait, waitTime } = this.shouldWaitBeforeRequest();

    if (shouldWait) {
      console.log(`Rate limiting: waiting ${waitTime}ms before next request`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  private async getActiveFeVersion(userAgent: string): Promise<string> {
    try {
      const response = await gotScraping({
        url: "https://duck.ai/",
        method: "GET",
        http2: false,
        headers: {
          "User-Agent": userAgent,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        }
      });
      const html = response.body;

      // Update entry script bundle name for the Error stack mock
      const entryScriptMatch = html.match(/\/dist\/duckai-dist\/entry\.duckai\.[a-f0-9]+\.js/);
      if (entryScriptMatch) {
        this.entryScriptName = entryScriptMatch[0];
      }

      const tagMatch = html.match(/data-version-tag=["']([^"']+)["']/);
      const shaMatch = html.match(/data-version-sha=["']([^"']+)["']/);
      if (tagMatch && shaMatch) {
        return `${tagMatch[1]}-${shaMatch[1]}`;
      }
    } catch (e) {
      // Ignore error and fallback
    }
    return "serp_20260623_020209_ET-86e443857a570e5721d1a26369c4d0389e98becf"; // Fallback to current latest version
  }

  private async getEncodedVqdHash(vqdHash: string, userAgent: string): Promise<string> {
    const jsScript = Buffer.from(vqdHash, 'base64').toString('utf-8');

    const dom = new JSDOM(
      `<iframe id="jsa" sandbox="allow-scripts allow-same-origin" srcdoc="<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy"; content="default-src 'none'; script-src 'unsafe-inline'">
</head>
<body></body>
</html>" style="position: absolute; left: -9999px; top: -9999px;"></iframe>`,
      {
        runScripts: 'dangerously',
        userAgent: userAgent,
        url: "https://duck.ai/"
      }
    );

    // Override webdriver and userAgent on Navigator PROTOTYPE (very important, JSDOM reads prototype!)
    Object.defineProperty(dom.window.Navigator.prototype, 'userAgent', {
      get: () => userAgent,
      configurable: true
    });
    Object.defineProperty(dom.window.Navigator.prototype, 'webdriver', {
      get: () => false,
      configurable: true
    });

    // Override userAgent and webdriver on main instance as fallback
    Object.defineProperty(dom.window.navigator, 'userAgent', {
      get: () => userAgent,
      configurable: true
    });
    Object.defineProperty(dom.window.navigator, 'webdriver', {
      get: () => false,
      configurable: true
    });

    // Mock HTML layout properties on HTMLElement prototype
    Object.defineProperties(dom.window.HTMLElement.prototype, {
      offsetWidth: {
        get() { return 100; },
        configurable: true
      },
      offsetHeight: {
        get() { return 30; },
        configurable: true
      },
      clientWidth: {
        get() { return 100; },
        configurable: true
      },
      clientHeight: {
        get() { return 30; },
        configurable: true
      },
      scrollHeight: {
        get() { return 30; },
        configurable: true
      },
      scrollWidth: {
        get() { return 100; },
        configurable: true
      }
    });

    dom.window.HTMLElement.prototype.getBoundingClientRect = function() {
      return {
        width: 100,
        height: 30,
        top: 10,
        left: 10,
        right: 110,
        bottom: 40,
        x: 10,
        y: 10,
        toJSON() { return {}; }
      } as any;
    };

    dom.window.top.__DDG_BE_VERSION__ = 1;
    dom.window.top.__DDG_FE_CHAT_HASH__ = 1;
    const jsa = dom.window.top.document.querySelector('#jsa') as HTMLIFrameElement;

    // Mask properties in iframe window context as well
    const iframeWindow = jsa.contentWindow;
    if (iframeWindow) {
      Object.defineProperty(iframeWindow.Navigator.prototype, 'userAgent', {
        get: () => userAgent,
        configurable: true
      });
      Object.defineProperty(iframeWindow.Navigator.prototype, 'webdriver', {
        get: () => false,
        configurable: true
      });

      Object.defineProperties(iframeWindow.HTMLElement.prototype, {
        offsetWidth: {
          get() { return 100; },
          configurable: true
        },
        offsetHeight: {
          get() { return 30; },
          configurable: true
        },
        clientWidth: {
          get() { return 100; },
          configurable: true
        },
        clientHeight: {
          get() { return 30; },
          configurable: true
        },
        scrollHeight: {
          get() { return 30; },
          configurable: true
        },
        scrollWidth: {
          get() { return 100; },
          configurable: true
        }
      });

      iframeWindow.HTMLElement.prototype.getBoundingClientRect = function() {
        return {
          width: 100,
          height: 30,
          top: 10,
          left: 10,
          right: 110,
          bottom: 40,
          x: 10,
          y: 10,
          toJSON() { return {}; }
        } as any;
      };
    }

    const contentDoc = jsa.contentDocument || jsa.contentWindow!.document;

    const meta = contentDoc.createElement('meta');
    meta.setAttribute('http-equiv', 'Content-Security-Policy');
    meta.setAttribute('content', "default-src 'none'; script-src 'unsafe-inline';");
    contentDoc.head.appendChild(meta);
    const result = await dom.window.eval(jsScript) as {
      client_hashes: string[];
      meta: Record<string, any>;
      [key: string]: any;
    };

    // Spoof client-side metadata properties injected by React wrapper
    result.meta.origin = "https://duck.ai";
    result.meta.duration = Math.floor(Math.random() * 5 + 8).toString();
    result.meta.stack = `Error\n    at l (https://duck.ai${this.entryScriptName}:2:1438602)\n    at async https://duck.ai${this.entryScriptName}:2:1288095`;

    result.client_hashes = result.client_hashes.map((t) => {
      const hash = createHash('sha256');
      hash.update(t);

      return hash.digest('base64');
    });

    return btoa(JSON.stringify(result));
  }

  private async getVQD(userAgent: string): Promise<VQDResponse> {
    const response = await gotScraping({
      url: "https://duck.ai/duckchat/v1/status",
      method: "GET",
      http2: false,
      headers: {
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-store",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "x-vqd-accept": "1",
        "User-Agent": userAgent,
        "Origin": "https://duck.ai:443",
        "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      // gotScraping supports context/referrer via options
      context: {
        referrer: "https://duck.ai/",
      }
    });

    const hashHeader = response.headers["x-vqd-hash-1"] as string;

    if (!hashHeader) {
      const bodySnippet = response.body ? response.body.slice(0, 500) : "empty body";
      throw new Error(
        `Missing x-vqd-hash-1 header. Status: ${response.statusCode}, Headers: ${JSON.stringify(response.headers)}, Body snippet: ${bodySnippet}`
      );
    }

    const encodedHash = await this.getEncodedVqdHash(hashHeader, userAgent);

    return { hash: encodedHash };
  }

  private async hashClientHashes(clientHashes: string[]): Promise<string[]> {
    return Promise.all(
      clientHashes.map(async (hash) => {
        const encoder = new TextEncoder();
        const data = encoder.encode(hash);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = new Uint8Array(hashBuffer);
        return btoa(
          hashArray.reduce((str, byte) => str + String.fromCharCode(byte), "")
        );
      })
    );
  }

  async chat(request: DuckAIRequest): Promise<string> {
    if (process.env.MOCK_DUCK_AI === "true") {
      return this.getMockResponse(request);
    }

    // Wait if rate limiting is needed
    await this.waitIfNeeded();

    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
    const vqd = await this.getVQD(userAgent);
    const activeFeVersion = await this.getActiveFeVersion(userAgent);

    // Update rate limit tracking BEFORE making the request
    const now = Date.now();
    this.rateLimitInfo.requestTimestamps.push(now);
    this.rateLimitInfo.lastRequestTime = now;
    this.saveRateLimitToStore();

    // Show compact rate limit status in server console
    this.rateLimitMonitor.printCompactStatus();

    // Generate random journey ID and signals to complete standard browser headers
    const journeyId = createHash("md5").update(Math.random().toString()).digest("hex");
    const startTimestamp = Date.now() - 10000;
    const mockSignalsObj = {
      start: startTimestamp,
      events: [
        { name: "clearConversation", delta: 1000 },
        { name: "startNewChat_free", delta: 1500 }
      ],
      end: startTimestamp + 9000
    };
    const feSignals = Buffer.from(JSON.stringify(mockSignalsObj)).toString("base64");

    const chatBody = {
      model: request.model,
      messages: request.messages,
      canUseTools: true,
      reasoningEffort: "none"
    };

    const response = await gotScraping({
      url: "https://duck.ai/duckchat/v1/chat",
      method: "POST",
      http2: false,
      headers: {
        "Accept": "text/event-stream",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "x-fe-version": activeFeVersion,
        "User-Agent": userAgent,
        "x-vqd-hash-1": vqd.hash,
        "x-ddg-journey-id": journeyId,
        "x-fe-signals": feSignals,
        "Origin": "https://duck.ai:443",
        "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      json: chatBody,
      throwHttpErrors: false,
    });

    // Handle rate limiting
    if (response.statusCode === 429) {
      const retryAfter = response.headers["retry-after"];
      const waitTime = retryAfter ? parseInt(retryAfter as string) * 1000 : 60000; // Default 1 minute
      throw new Error(
        `Rate limited. Retry after ${waitTime}ms. Status: ${response.statusCode}`
      );
    }

    if (response.statusCode !== 200) {
      throw new Error(
        `DuckAI API error: ${response.statusCode} ${response.statusMessage}`
      );
    }

    const text = response.body;

    // Check for errors
    try {
      const parsed = JSON.parse(text);
      if (parsed.action === "error") {
        throw new Error(`Duck.ai error: ${JSON.stringify(parsed)}`);
      }
    } catch (e) {
      // Not JSON, continue processing
    }

    // Extract the LLM response from the streamed response
    let llmResponse = "";
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const json = JSON.parse(line.slice(6));
          if (json.message) {
            llmResponse += json.message;
          }
        } catch (e) {
          // Skip invalid JSON lines
        }
      }
    }

    const finalResponse = llmResponse.trim();

    // If response is empty, provide a fallback
    if (!finalResponse) {
      console.warn("Duck.ai returned empty response, using fallback");
      return "I apologize, but I'm unable to provide a response at the moment. Please try again.";
    }

    return finalResponse;
  }

  async chatStream(request: DuckAIRequest): Promise<ReadableStream<string>> {
    if (process.env.MOCK_DUCK_AI === "true") {
      const mockText = await this.getMockResponse(request);
      return new ReadableStream({
        start(controller) {
          controller.enqueue(mockText);
          controller.close();
        },
      });
    }

    // Wait if rate limiting is needed
    await this.waitIfNeeded();

    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const vqd = await this.getVQD(userAgent);
    const activeFeVersion = await this.getActiveFeVersion(userAgent);

    // Update rate limit tracking BEFORE making the request
    const now = Date.now();
    this.rateLimitInfo.requestTimestamps.push(now);
    this.rateLimitInfo.lastRequestTime = now;
    this.saveRateLimitToStore();

    // Show compact rate limit status in server console
    this.rateLimitMonitor.printCompactStatus();

    // Generate random journey ID and signals to complete standard browser headers
    const journeyId = createHash("md5").update(Math.random().toString()).digest("hex");
    const startTimestamp = Date.now() - 10000;
    const mockSignalsObj = {
      start: startTimestamp,
      events: [
        { name: "clearConversation", delta: 1000 },
        { name: "startNewChat_free", delta: 1500 }
      ],
      end: startTimestamp + 9000
    };
    const feSignals = Buffer.from(JSON.stringify(mockSignalsObj)).toString("base64");

    const chatBody = {
      model: request.model,
      messages: request.messages,
      canUseTools: true,
      reasoningEffort: "none"
    };

    const responseStream = gotScraping.stream({
      url: "https://duck.ai/duckchat/v1/chat",
      method: "POST",
      http2: false,
      headers: {
        "Accept": "text/event-stream",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "x-fe-version": activeFeVersion,
        "User-Agent": userAgent,
        "x-vqd-hash-1": vqd.hash,
        "x-ddg-journey-id": journeyId,
        "x-fe-signals": feSignals,
        "Origin": "https://duck.ai:443",
        "sec-ch-ua": '"Not_A Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
      json: chatBody,
    });

    return new ReadableStream({
      start(controller) {
        let isClosed = false;

        const safeClose = () => {
          if (!isClosed) {
            isClosed = true;
            try {
              controller.close();
            } catch (e) {
              // Ignore invalid state errors
            }
          }
        };

        const safeError = (err: Error) => {
          if (!isClosed) {
            isClosed = true;
            try {
              controller.error(err);
            } catch (e) {
              // Ignore invalid state errors
            }
          }
        };

        responseStream.on("response", (res) => {
          if (res.statusCode === 429) {
            const retryAfter = res.headers["retry-after"];
            const waitTime = retryAfter ? parseInt(retryAfter as string) * 1000 : 60000;
            safeError(new Error(`Rate limited. Retry after ${waitTime}ms. Status: 429`));
            responseStream.destroy();
          } else if (res.statusCode !== 200) {
            safeError(new Error(`DuckAI API error: ${res.statusCode} ${res.statusMessage}`));
            responseStream.destroy();
          }
        });

        const decoder = new TextDecoder();
        let buffer = "";
        responseStream.on("data", (chunk: Buffer) => {
          if (isClosed) return;
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          // Save the last incomplete line to buffer (will be empty if line ends with \n)
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const json = JSON.parse(line.slice(6));
                if (json.message && !isClosed) {
                  controller.enqueue(json.message);
                }
              } catch (e) {
                // Skip invalid JSON
              }
            }
          }
        });

        responseStream.on("end", () => {
          // Flush the decoder and process any remaining buffer
          buffer += decoder.decode();
          if (buffer) {
            const lines = buffer.split("\n");
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const json = JSON.parse(line.slice(6));
                  if (json.message && !isClosed) {
                    controller.enqueue(json.message);
                  }
                } catch (e) {
                  // Skip invalid JSON
                }
              }
            }
          }
          safeClose();
        });

        responseStream.on("error", (err) => {
          safeError(err);
        });
      },
      cancel() {
        responseStream.destroy();
      }
    });
  }

  getAvailableModels(): string[] {
    return [
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "claude-haiku-4-5"
    ];
  }
}
