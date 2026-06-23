# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Running Services
- Run development server (with hot reload): `bun run dev`
- Start production server: `bun run start`

### Running Tests
- Run all tests: `bun test`
- Run watch mode tests: `bun test:watch`
- Run core OpenAI API tests: `bun run test:openai`
- Run full OpenAI SDK integration tests: `bun run test:openai-full`
- Run function calling/tools tests: `bun run test:tools`
- Run end-to-end tests: `bun run test:e2e`
- Run specific test file: `bun test tests/server.test.ts`

### Docker Commands
- Build local Docker image: `docker build -t duckai .`
- Run local Docker container (live mode): `docker run -p 3000:3000 -e MOCK_DUCK_AI=false duckai`

---

## High-Level Architecture & Components

This project acts as an OpenAI-compatible proxy server for the free anonymous Duck.ai backend.

### Core Modules
1. **`src/server.ts`**
   - Implements the HTTP server using `Bun.serve`.
   - Handles CORS headers and routing for `/health`, `/v1/models`, and `/v1/chat/completions`.

2. **`src/openai-service.ts`**
   - Directs chat completions logic and manages request validation (roles, messages, tool shapes).
   - Coordinates function execution results matching back into subsequent model turns.
   - Formats SSE streaming chunk payloads (`data: {...}`, `data: [DONE]`).

3. **`src/duckai.ts`**
   - The low-level API connector to Duck.ai.
   - **Challenge Bypass**: Evaluates DDG's JavaScript challenge script inside a sandboxed `JSDOM` instance, mocking browser window layout attributes (`offsetWidth`, `getBoundingClientRect`) and navigator credentials to generate valid `x-vqd-hash-1` payloads.
   - **GotScraping**: Uses `gotScraping` to spoof Chromium TLS fingerprints.
   - **HTTP/2 Workaround**: Configured with `http2: false` on requests to bypass local TLS origin verification errors (`Requested origin does not match server:443`).
   - Supports offline simulation via `MOCK_DUCK_AI=true`.

4. **`src/tool-service.ts`**
   - Handles client-submitted OpenAI tool definitions, matches user instructions, and maps execution results back to assistant calls.

5. **`src/rate-limit-store.ts` & `src/shared-rate-limit-monitor.ts`**
   - Implements rate-limiting through a sliding window of request timestamps, persisted into a shared OS-level temporary json file to coordinate constraints across multiple server processes.

---

## Code Conventions & Style
- **Runtime & Package Manager**: Always use `Bun` runtime, `bun install`, and `bun test`.
- **Language**: Strict TypeScript (`tsconfig.json`).
- **Style Matching**: Follow the surrounding codebase style—camelCase variables, PascalCase classes, explicit return types for services, and concise asynchronous code with `async`/`await`.
- **Mocking**: For unit testing, toggled with `process.env.MOCK_DUCK_AI = "true"`.
