# @endevre/entry-on-kitchen

Official JavaScript/TypeScript library for executing recipes on the Entry on Kitchen API. Supports both synchronous execution and real-time HTTP streaming.

[![npm version](https://badge.fury.io/js/%40endevre%2Fentry-on-kitchen.svg)](https://www.npmjs.com/package/@endevre/entry-on-kitchen)

## Installation

```bash
npm install @endevre/entry-on-kitchen
```

```bash
yarn add @endevre/entry-on-kitchen
```

```bash
pnpm add @endevre/entry-on-kitchen
```

## Quick Start

```typescript
import { KitchenClient } from "@endevre/entry-on-kitchen";

// Initialize the client
const client = new KitchenClient({
  authCode: "your-auth-code-here",
  entryPoint: "entry", // or "beta", "raydev", etc.
});

// Synchronous execution
const result = await client.sync({
  recipeId: "your-recipe-id",
  entryId: "your-entry-id",
  body: { message: "Hello, Kitchen!" },
});

console.log(result);
```

## KitchenClient Class

### Constructor

```typescript
new KitchenClient(config: KitchenClientConfig)
```

**Parameters:**
- `authCode` (string, required): Your X-Entry-Auth-Code for authentication
- `entryPoint` (string, optional): Entry point environment. Defaults to `"entry"` (production)

**Throws:**
- `Error` if `authCode` is not provided

### Methods

#### `sync(params)`

Execute a recipe synchronously and wait for the complete result.

**Parameters:**
- `recipeId` (string): The ID of the pipeline/recipe
- `entryId` (string): The ID of the entry block
- `body` (unknown): Request body data (object or JSON string)
- `useKitchenBilling` (boolean, optional): Enable Kitchen billing
- `llmOverride` (string, optional): Override the LLM model (e.g., "gpt-4", "claude-3")
- `thinkingOverride` (string, optional): Standardized runtime thinking level: `off`, `low`, `medium`, `high`, `xhigh`, or `max`
- `apiKeyOverride` (object, optional): Override API keys for external services

**Returns:** `Promise<KitchenResponse>`

```typescript
const result = await client.sync({
  recipeId: "abc123",
  entryId: "def456",
  body: {
    message: "Hello!",
    provider: "google_genai",
    model: "gemini-2.5-flash",
  },
});

if (result._statusCode && result._statusCode !== 200) {
  console.error("Error:", result.error);
} else {
  console.log("Success:", result.result);
}
```

#### `stream(params)`

Execute a recipe with real-time streaming. Yields events as they arrive.

**Parameters:**
- `recipeId` (string): The ID of the pipeline/recipe
- `entryId` (string): The ID of the entry block
- `body` (unknown): Request body data
- `useKitchenBilling` (boolean, optional): Enable Kitchen billing
- `llmOverride` (string, optional): Override the LLM model (e.g., "gpt-4", "claude-3")
- `thinkingOverride` (string, optional): Standardized runtime thinking level: `off`, `low`, `medium`, `high`, `xhigh`, or `max`
- `apiKeyOverride` (object, optional): Override API keys for external services

**Returns:** `AsyncIterable<StreamEvent>`

**Event Types:**
- `"progress"`: Execution progress updates
- `"result"`: Output data from blocks
- `"delta"`: Incremental content updates (for streaming LLM responses)
- `"info"`: Informational messages
- `"end"`: Final result (marks completion)

```typescript
for await (const event of client.stream({
  recipeId: "abc123",
  entryId: "def456",
  body: { message: "Tell me a joke" },
})) {
  const { type, data, socket } = event;

  if (type === "progress") {
    console.log(`Progress: ${data.blockPosition}/${data.blocksToExitBlock}`);
  } else if (type === "result") {
    console.log(`Result from ${socket}:`, data);
  } else if (type === "delta") {
    console.log(`Delta update for ${socket}:`, data);
  } else if (type === "end") {
    console.log("Complete!", data);
  }
}
```

## Environment Configuration

### Production
```typescript
const client = new KitchenClient({
  authCode: "your-auth-code",
  entryPoint: "entry", // Uses https://entry.entry.on.kitchen
});
```

### Beta
```typescript
const client = new KitchenClient({
  authCode: "your-auth-code",
  entryPoint: "beta", // Uses https://beta.entry.on.kitchen
});
```

### Custom Environment
```typescript
const client = new KitchenClient({
  authCode: "your-auth-code",
  entryPoint: "raydev", // Uses https://raydev.entry.on.kitchen
});
```

## Optional Features

### Kitchen Billing

Enable Kitchen billing for your recipe execution:

```typescript
const result = await client.sync({
  recipeId: "abc123",
  entryId: "def456",
  body: { message: "Hello!" },
  useKitchenBilling: true,
});
```

### LLM Model Override

Override the LLM model used in your recipe:

```typescript
const result = await client.sync({
  recipeId: "abc123",
  entryId: "def456",
  body: { message: "Write a poem" },
  llmOverride: "gpt-4",
});

// Or with streaming
for await (const event of client.stream({
  recipeId: "abc123",
  entryId: "def456",
  body: { message: "Write a poem" },
  llmOverride: "claude-3",
})) {
  // Handle events
}
```

### Thinking Override

Set a standardized runtime thinking level for the selected model. Omit
`thinkingOverride` to use the recipe/Chef default; `auto` is not sent as a
runtime override.

```typescript
const result = await client.sync({
  recipeId: "abc123",
  entryId: "def456",
  body: { message: "Solve this carefully" },
  thinkingOverride: "high",
});
```

### Combining Options

You can use both options together:

```typescript
const result = await client.sync({
  recipeId: "abc123",
  entryId: "def456",
  body: { message: "Hello!" },
  useKitchenBilling: true,
  llmOverride: "gpt-4",
});
```

## TypeScript Support

This library is written in TypeScript and includes full type definitions:

```typescript
import type {
  KitchenClientConfig,
  KitchenResponse,
  SyncParams,
  StreamParams,
  StreamEvent,
  StreamEventType,
  ThinkingLevel,
} from "@endevre/entry-on-kitchen";
```

## Error Handling

```typescript
import { KitchenClient } from "@endevre/entry-on-kitchen";

const client = new KitchenClient({
  authCode: "your-auth-code",
});

try {
  const result = await client.sync({
    recipeId: "abc123",
    entryId: "def456",
    body: { message: "Hello!" },
  });

  // Check for error response
  if (result._statusCode && result._statusCode !== 200) {
    console.error("Request failed:", result.error);
    return;
  }

  console.log("Success:", result.result);
} catch (error) {
  console.error("Unexpected error:", error);
}
```

## Migration from v0.2.x

Version 0.3.0 is a breaking change from v0.2.x. See [MIGRATION.md](./MIGRATION.md) for detailed migration instructions.

### Quick Migration

**Before (v0.2.x):**
```typescript
import { EntryBlock } from "entry-on-kitchen";

const entry = new EntryBlock({
  pipelineId: "abc123",
  entryBlockId: "def456",
  entryAuthCode: "your-auth-code",
  entryPoint: "beta",
});

const result = entry.runSync({ message: "Hello!" });
const result = await entry.runAsync({ message: "Hello!" });
```

**After (v0.3.0):**
```typescript
import { KitchenClient } from "@endevre/entry-on-kitchen";

const client = new KitchenClient({
  authCode: "your-auth-code",
  entryPoint: "beta",
});

const result = await client.sync({
  recipeId: "abc123",
  entryId: "def456",
  body: { message: "Hello!" },
});

// Or with streaming
for await (const event of client.stream({
  recipeId: "abc123",
  entryId: "def456",
  body: { message: "Hello!" },
})) {
  // Handle events
}
```

## Requirements

- Node.js 18 or higher
- Browser with native `fetch` support (or use a polyfill)

## License

ISC

## Support

For issues and questions: contact@endevre.com
