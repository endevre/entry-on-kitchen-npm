import { describe, it, expect, beforeEach, vi } from "vitest";
import { KitchenClient, applyDelta } from "../client";
import {
  createExternalTool,
  createKitchenEntryTool,
  createToolResult,
  getToolCallRequest,
  withToolResults,
  withTools,
} from "../tools";
import type { DeltaOperation } from "../types";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("KitchenClient", () => {
  let client: KitchenClient;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create a client with auth code", () => {
      client = new KitchenClient({ authCode: "test-code" });
      expect(client).toBeDefined();
    });

    it("should throw error if authCode is not provided", () => {
      expect(() => new KitchenClient({ authCode: "" })).toThrow("authCode is required");
    });

    it("should use default entry point 'entry'", () => {
      client = new KitchenClient({ authCode: "test-code" });
      // Client is created successfully
      expect(client).toBeDefined();
    });

    it("should use custom entry point", () => {
      client = new KitchenClient({
        authCode: "test-code",
        entryPoint: "beta",
      });
      expect(client).toBeDefined();
    });
  });

  describe("sync", () => {
    beforeEach(() => {
      client = new KitchenClient({ authCode: "test-auth-code", entryPoint: "raydev" });
    });

    it("should execute sync request successfully", async () => {
      const mockResponse = {
        runId: "test-run-id",
        status: "finished",
        result: { response: "Hello!" },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: async () => JSON.stringify(mockResponse),
      });

      const result = await client.sync({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://raydev.entry.on.kitchen/test-recipe/test-entry/sync",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Entry-Auth-Code": "test-auth-code",
          },
          body: '{"message":"Hello!"}',
        },
      );

      expect(result).toEqual(mockResponse);
    });

    it("should handle error responses gracefully", async () => {
      const mockErrorResponse = {
        error: "Unable to run",
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: new Headers(),
        text: async () => JSON.stringify(mockErrorResponse),
      });

      const result = await client.sync({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
      });

      expect(result._statusCode).toBe(500);
      expect(result.error).toBe("Unable to run");
    });

    it("should accept string body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: async () => JSON.stringify({ status: "finished" }),
      });

      await client.sync({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: '{"message":"Hello!"}',
      });

      expect(mockFetch).toHaveBeenCalled();
    });

    it("should serialize llmOverride using models__llm_override", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: async () => JSON.stringify({ status: "finished" }),
      });

      await client.sync({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
        llmOverride: "openai/gpt-5.4",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://raydev.entry.on.kitchen/test-recipe/test-entry/sync",
        expect.objectContaining({
          body: JSON.stringify({
            message: "Hello!",
            KITCHEN_MODELS_OVERRIDE: {
              models__llm_override: "openai/gpt-5.4",
            },
          }),
        }),
      );
    });
  });

  describe("tools", () => {
    beforeEach(() => {
      client = new KitchenClient({ authCode: "test-auth-code", entryPoint: "raydev" });
    });

    it("should build canonical tool and tool result payloads", () => {
      const externalTool = createExternalTool({
        name: "get user plan",
        description: "Get a user's plan",
        inputSchema: {
          type: "object",
          properties: { userId: { type: "string" } },
          required: ["userId"],
        },
      });
      const kitchenTool = createKitchenEntryTool({
        name: "summarize_youtube",
        description: "Summarize a video",
        pipelineId: "recipe-1",
        entryBlockId: "entry-1",
      });
      const toolResult = createToolResult({
        toolCallId: "call-1",
        name: externalTool.name,
        output: { plan: "pro" },
      });

      expect(externalTool.name).toBe("get_user_plan");
      expect(externalTool.executor.type).toBe("external");
      expect(kitchenTool.executor.type).toBe("entry");
      expect(toolResult.status).toBe("success");
    });

    it("should merge tools and tool results into entry bodies", () => {
      const tool = createExternalTool({
        name: "lookup",
        description: "Lookup something",
      });
      const body = withTools({ messages: [] }, [tool]);
      const resumedBody = withToolResults(
        { messages: [] },
        [createToolResult({ toolCallId: "call-1", name: "lookup", output: { ok: true } })],
        {
          type: "LLMContinuation",
          version: 1,
          provider: "openai",
          model: "gpt-test",
          conversation: [],
        },
      );

      expect(body.tools).toEqual([tool]);
      expect(resumedBody.tool_results).toHaveLength(1);
      expect(resumedBody.continuation).toMatchObject({ provider: "openai" });
    });

    it("should detect tool call requests from Kitchen responses", () => {
      const request = getToolCallRequest({
        status: "finished",
        result: JSON.stringify({
          status: "requires_tool_outputs",
          tool_calls: [
            {
              type: "LLMToolCall",
              version: 1,
              id: "call-1",
              name: "lookup",
              arguments: { id: "123" },
            },
          ],
          continuation: {
            type: "LLMContinuation",
            version: 1,
            provider: "openai",
            model: "gpt-test",
            conversation: [],
          },
        }),
      });

      expect(request?.tool_calls[0]?.name).toBe("lookup");
    });

    it("should execute external tool handlers until completion", async () => {
      const requestPayload = {
        status: "requires_tool_outputs",
        tool_calls: [
          {
            type: "LLMToolCall",
            version: 1,
            id: "call-1",
            name: "lookup",
            arguments: { id: "123" },
          },
        ],
        continuation: {
          type: "LLMContinuation",
          version: 1,
          provider: "openai",
          model: "gpt-test",
          conversation: [],
        },
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          text: async () => JSON.stringify({ status: "finished", result: JSON.stringify(requestPayload) }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          text: async () => JSON.stringify({ status: "finished", result: { answer: "done" } }),
        });

      const result = await client.runWithTools({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { messages: [] },
        tools: [createExternalTool({ name: "lookup", description: "Lookup" })],
        handlers: {
          lookup: async (args) => ({ found: args.id }),
        },
      });

      expect(result.result).toEqual({ answer: "done" });
      const secondBody = JSON.parse((mockFetch.mock.calls[1]?.[1] as RequestInit).body as string);
      expect(secondBody.tool_results[0]).toMatchObject({
        tool_call_id: "call-1",
        name: "lookup",
        status: "success",
      });
    });
  });

  describe("stream", () => {
    beforeEach(() => {
      client = new KitchenClient({ authCode: "test-auth-code", entryPoint: "raydev" });
    });

    it("should stream events correctly", async () => {
      const streamData =
        '{"runId":"test-id","type":"progress","time":123456,"data":{"blockPosition":1,"blocksToExitBlock":3},"socket":null,"statusCode":200}' +
        '{"runId":"test-id","type":"end","time":123457,"data":{"status":"finished"},"socket":null,"statusCode":200}';

      const readableStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(streamData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: readableStream,
      });

      const events: unknown[] = [];
      for await (const event of client.stream({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "progress",
        runId: "test-id",
      });
      expect(events[1]).toMatchObject({
        type: "end",
        runId: "test-id",
      });
    });

    it("should handle different event types", async () => {
      const streamData =
        '{"runId":"test-id","type":"progress","time":123456,"data":{"blockPosition":1,"blocksToExitBlock":3},"socket":null,"statusCode":200}' +
        '{"runId":"test-id","type":"result","time":123457,"data":{"text":"hello"},"socket":"response","statusCode":200}' +
        '{"runId":"test-id","type":"delta","time":123458,"data":[["i",0,5,"world"]],"socket":"response","statusCode":200}' +
        '{"runId":"test-id","type":"info","time":123459,"data":{"message":"Processing"},"socket":null,"statusCode":200}' +
        '{"runId":"test-id","type":"end","time":123460,"data":{"status":"finished"},"socket":null,"statusCode":200}';

      const readableStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(streamData));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: readableStream,
      });

      const events: unknown[] = [];
      for await (const event of client.stream({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(5);
      expect(events[0]).toMatchObject({ type: "progress" });
      expect(events[1]).toMatchObject({ type: "result", socket: "response" });
      expect(events[2]).toMatchObject({ type: "delta" });
      expect(events[3]).toMatchObject({ type: "info" });
      expect(events[4]).toMatchObject({ type: "end" });
    });

    it("should handle chunked JSON objects", async () => {
      // Simulate JSON objects arriving in multiple chunks
      const chunk1 = '{"runId":"test-id","type":"progress","time":123456,"data":';
      const chunk2 = '{"blockPosition":1,"blocksToExitBlock":3},"socket":null,"statusCode":200}';
      const chunk3 = '{"runId":"test-id","type":"end","time":123457,"data":{';
      const chunk4 = '"status":"finished"},"socket":null,"statusCode":200}';

      const readableStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(chunk1));
          controller.enqueue(new TextEncoder().encode(chunk2));
          controller.enqueue(new TextEncoder().encode(chunk3));
          controller.enqueue(new TextEncoder().encode(chunk4));
          controller.close();
        },
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: readableStream,
      });

      const events: unknown[] = [];
      for await (const event of client.stream({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "progress" });
      expect(events[1]).toMatchObject({ type: "end" });
    });

    it("should throw on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        body: null,
      });

      await expect(
        (async () => {
          const events = [];
          for await (const event of client.stream({
            recipeId: "test-recipe",
            entryId: "test-entry",
            body: { message: "Hello!" },
          })) {
            events.push(event);
          }
        })(),
      ).rejects.toThrow("HTTP error! status: 500");
    });
  });

  describe("URL construction", () => {
    it("should construct correct URL for entry point 'entry'", async () => {
      client = new KitchenClient({ authCode: "test-code", entryPoint: "entry" });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: async () => '{"status":"finished"}',
      });

      await client.sync({
        recipeId: "abc123",
        entryId: "def456",
        body: {},
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://entry.entry.on.kitchen/abc123/def456/sync",
        expect.any(Object),
      );
    });

    it("should construct correct URL for custom entry point", async () => {
      client = new KitchenClient({ authCode: "test-code", entryPoint: "beta" });

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: async () => '{"status":"finished"}',
      });

      await client.sync({
        recipeId: "abc123",
        entryId: "def456",
        body: {},
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://beta.entry.on.kitchen/abc123/def456/sync",
        expect.any(Object),
      );
    });
  });

  describe("applyDelta", () => {
    it("should insert text at position", () => {
      const text = "Hello";
      const ops: DeltaOperation[] = [["i", 5, " World"]];
      const result = applyDelta(text, ops);
      expect(result).toBe("Hello World");
    });

    it("should insert at beginning", () => {
      const text = "World";
      const ops: DeltaOperation[] = [["i", 0, "Hello "]];
      const result = applyDelta(text, ops);
      expect(result).toBe("Hello World");
    });

    it("should delete characters", () => {
      const text = "Hello World";
      const ops: DeltaOperation[] = [["d", 5, 1]];
      const result = applyDelta(text, ops);
      expect(result).toBe("HelloWorld");
    });

    it("should delete single character", () => {
      const text = "Hello";
      const ops: DeltaOperation[] = [["d", 4]];
      const result = applyDelta(text, ops);
      expect(result).toBe("Hell");
    });

    it("should handle multiple operations", () => {
      const text = "Hi";
      const ops: DeltaOperation[] = [
        ["i", 2, " There"],
        ["d", 1, 1],
      ];
      const result = applyDelta(text, ops);
      // Insert " There" at position 2: "Hi There"
      // Delete at position 1 (after offset of +6 from insert): position 7
      // Result: "Hi Ther"
      expect(result).toBe("Hi Ther");
    });

    it("should handle empty string", () => {
      const text = "";
      const ops: DeltaOperation[] = [["i", 0, "Hello"]];
      const result = applyDelta(text, ops);
      expect(result).toBe("Hello");
    });

    it("should maintain offset for multiple inserts", () => {
      const text = "ABC";
      const ops: DeltaOperation[] = [
        ["i", 1, "1"],
        ["i", 3, "2"],
        ["i", 5, "3"],
      ];
      const result = applyDelta(text, ops);
      // Start: "ABC"
      // Insert "1" at position 1: "A1BC" (offset = 1)
      // Insert "2" at position 4 (3+1): "A1BC2" (offset = 2)
      // Insert "3" at position 7 (5+2): "A1BC23" (offset = 3)
      expect(result).toBe("A1BC23");
    });

    it("should maintain offset for insert then delete", () => {
      const text = "ABCD";
      const ops: DeltaOperation[] = [
        ["i", 2, "XX"],
        ["d", 3, 2],
      ];
      const result = applyDelta(text, ops);
      // Start: "ABCD"
      // Insert "XX" at position 2: "ABXXCD" (offset = 2)
      // Delete 2 chars at position 5 (3+2): only 'D' exists at position 5
      // Result: "ABXXC"
      expect(result).toBe("ABXXC");
    });
  });
});
