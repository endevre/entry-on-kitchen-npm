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
import type { DeltaOperation, StreamEvent } from "../types";

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  const payload = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
}

describe("KitchenClient", () => {
  let client: KitchenClient;

  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("constructor", () => {
    it("should create a client with auth code", () => {
      client = new KitchenClient({
        authorization: { kind: "entry_code", code: "test-code" },
      });
      expect(client).toBeDefined();
    });

    it("should throw error if authorization is not provided", () => {
      expect(() => new KitchenClient({ authorization: undefined as never })).toThrow("authorization is required");
    });

    it("should use default entry point 'entry'", () => {
      client = new KitchenClient({
        authorization: { kind: "entry_code", code: "test-code" },
      });
      // Client is created successfully
      expect(client).toBeDefined();
    });

    it("should use custom entry point", () => {
      client = new KitchenClient({
        authorization: { kind: "entry_code", code: "test-code" },
        entryPoint: "beta",
      });
      expect(client).toBeDefined();
    });
  });

  describe("sync", () => {
    beforeEach(() => {
      client = new KitchenClient({
        authorization: { kind: "entry_code", code: "test-auth-code" },
        entryPoint: "raydev",
      });
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

    it("should serialize thinkingOverride using KITCHEN_THINKING_OVERRIDE", async () => {
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
        thinkingOverride: "high",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://raydev.entry.on.kitchen/test-recipe/test-entry/sync",
        expect.objectContaining({
          body: JSON.stringify({
            message: "Hello!",
            KITCHEN_MODELS_OVERRIDE: {
              models__llm_override: "openai/gpt-5.4",
            },
            KITCHEN_THINKING_OVERRIDE: "high",
          }),
        }),
      );
    });

    it("should reject unsupported thinkingOverride values at the client boundary", async () => {
      await expect(
        client.sync({
          recipeId: "test-recipe",
          entryId: "test-entry",
          body: { message: "Hello!" },
          thinkingOverride: "auto" as never,
        }),
      ).rejects.toThrow("Invalid thinkingOverride");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should pass agent metadata as tracing headers", async () => {
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
        agentMetadata: {
          agentId: "agent-1",
          agentSessionId: "session-1",
          agentRunId: "run-1",
          workspaceId: "workspace-1",
          idempotencyKey: "idem-1",
        },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://raydev.entry.on.kitchen/test-recipe/test-entry/sync",
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-Kitchen-Agent-Id": "agent-1",
            "X-Kitchen-Agent-Session-Id": "session-1",
            "X-Kitchen-Agent-Run-Id": "run-1",
            "X-Kitchen-Workspace-Id": "workspace-1",
            "X-Kitchen-Idempotency-Key": "idem-1",
          }),
        }),
      );
    });
  });

  describe("tools", () => {
    beforeEach(() => {
      client = new KitchenClient({
        authorization: { kind: "entry_code", code: "test-auth-code" },
        entryPoint: "raydev",
      });
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
        thinkingOverride: "high",
      });

      expect(result.result).toEqual({ answer: "done" });
      const secondBody = JSON.parse((mockFetch.mock.calls[1]?.[1] as RequestInit).body as string);
      expect(secondBody.tool_results[0]).toMatchObject({
        tool_call_id: "call-1",
        name: "lookup",
        status: "success",
      });
      expect(secondBody.KITCHEN_THINKING_OVERRIDE).toBe("high");
    });
  });

  describe("stream", () => {
    beforeEach(() => {
      client = new KitchenClient({
        authorization: { kind: "entry_code", code: "test-auth-code" },
        entryPoint: "raydev",
      });
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

    it("should abort the active stream request", async () => {
      const controller = new AbortController();
      let requestSignal: AbortSignal | null | undefined;
      let markFetchStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => {
        markFetchStarted = resolve;
      });
      mockFetch.mockImplementationOnce((_url, init?: RequestInit) => {
        requestSignal = init?.signal;
        markFetchStarted();
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
        });
      });

      const consuming = (async () => {
        for await (const _event of client.stream({
          recipeId: "test-recipe",
          entryId: "test-entry",
          body: { message: "Hello!" },
          signal: controller.signal,
        })) {
          // The request remains pending until it is aborted.
        }
      })();

      await fetchStarted;
      expect(requestSignal).toBe(controller.signal);
      controller.abort(new DOMException("Stopped by user", "AbortError"));
      await expect(consuming).rejects.toMatchObject({ name: "AbortError", message: "Stopped by user" });
    });

    it("should not yield buffered events after abort", async () => {
      const controller = new AbortController();
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: sseStream([
          {
            runId: "run-buffered",
            seq: 1,
            type: "progress",
            time: 1,
            data: { message: "first" },
            statusCode: 200,
          },
          {
            runId: "run-buffered",
            seq: 2,
            type: "progress",
            time: 2,
            data: { message: "second" },
            statusCode: 200,
          },
        ]),
      });

      const iterator = client.stream({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
        signal: controller.signal,
      })[Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toMatchObject({
        value: { runId: "run-buffered", seq: 1 },
        done: false,
      });
      controller.abort(new DOMException("Stopped with buffered output", "AbortError"));
      await expect(iterator.next()).rejects.toMatchObject({
        name: "AbortError",
        message: "Stopped with buffered output",
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

    it("should decode stringified SSE events from stream", async () => {
      const stringifiedEvent = JSON.stringify({
        runId: null,
        type: "end",
        time: 123456,
        data: JSON.stringify({
          runId: null,
          status: "error",
          error: "bad request, user does not have permission to execute pipeline",
        }),
        socket: null,
        statusCode: 400,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: sseStream([stringifiedEvent]),
      });

      const events: StreamEvent[] = [];
      for await (const event of client.stream({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: "end",
        statusCode: 400,
      });
      expect(events[0].data).toEqual({
        runId: null,
        status: "error",
        error: "bad request, user does not have permission to execute pipeline",
      });
    });

    it("should hydrate terminal events from final payload refs in normal stream", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: sseStream([
            {
              runId: "run-4",
              seq: 1,
              type: "end",
              time: 1,
              data: {
                runId: "run-4",
                status: "finished",
                finalPayloadRef: { url: "https://signed.example/final-normal-stream.json" },
                error: null,
              },
              statusCode: 200,
            },
          ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ runId: "run-4", status: "finished", result: "{\"ok\":true}" }),
        });

      const events: StreamEvent[] = [];
      for await (const event of client.stream({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        runId: "run-4",
        seq: 1,
        type: "end",
        data: { runId: "run-4", status: "finished", result: "{\"ok\":true}" },
      });
      expect(mockFetch).toHaveBeenCalledWith("https://signed.example/final-normal-stream.json");
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

    it("should reconnect a resumable stream after a clean close before terminal event", async () => {
      const controller = new AbortController();
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: sseStream([
            {
              runId: "run-1",
              seq: 1,
              type: "progress",
              time: 1,
              data: { message: "started" },
              statusCode: 200,
            },
          ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ runId: "run-1", events: [], status: "running" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ pipelineRun: { runId: "run-1", status: "running" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: sseStream([
            {
              runId: "run-1",
              seq: 2,
              type: "end",
              time: 2,
              data: { status: "finished" },
              statusCode: 200,
            },
          ]),
        });

      const events = [];
      for await (const event of client.streamResumable({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
        maxReconnects: 1,
        reconnectDelayMs: 0,
        signal: controller.signal,
      })) {
        events.push(event);
      }

      expect(events.map((event) => event.type)).toEqual(["progress", "end"]);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://raydev.entry.on.kitchen/resumestream/run-1?after=1",
        expect.objectContaining({ method: "GET", signal: controller.signal }),
      );
    });

    it("should abort while waiting to reconnect a resumable stream", async () => {
      const controller = new AbortController();
      let markStatusRead!: () => void;
      const statusRead = new Promise<void>((resolve) => {
        markStatusRead = resolve;
      });
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: sseStream([
            {
              runId: "run-abort",
              seq: 1,
              type: "progress",
              time: 1,
              data: { message: "started" },
              statusCode: 200,
            },
          ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ runId: "run-abort", events: [], status: "running" }),
        })
        .mockImplementationOnce(async () => {
          markStatusRead();
          return {
            ok: true,
            json: async () => ({ pipelineRun: { runId: "run-abort", status: "running" } }),
          };
        });

      const iterator = client.streamResumable({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
        reconnectDelayMs: 10_000,
        signal: controller.signal,
      })[Symbol.asyncIterator]();

      await expect(iterator.next()).resolves.toMatchObject({
        value: { runId: "run-abort", type: "progress" },
        done: false,
      });
      const reconnecting = iterator.next();
      await statusRead;
      controller.abort(new DOMException("Stopped during reconnect", "AbortError"));

      await expect(reconnecting).rejects.toMatchObject({
        name: "AbortError",
        message: "Stopped during reconnect",
      });
    });

    it("should synthesize a terminal event from run status when stream events were already cleaned up", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: sseStream([
            {
              runId: "run-2",
              seq: 3,
              type: "progress",
              time: 1,
              data: { message: "almost done" },
              statusCode: 200,
            },
          ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            runId: "run-2",
            events: [],
            status: "finished",
            finalPayloadRef: { bucket: "b", key: "k", url: "https://signed.example/final.json" },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            pipelineRun: {
              runId: "run-2",
              status: "finished",
              stream: { finalSeq: 4, eventsAvailable: false },
              finalPayloadRef: { bucket: "b", key: "k", url: "https://signed.example/final.json" },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ runId: "run-2", status: "finished", result: "{\"ok\":true}" }),
        });

      const events = [];
      for await (const event of client.streamResumable({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
        maxReconnects: 1,
        reconnectDelayMs: 0,
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        runId: "run-2",
        seq: 4,
        type: "end",
        data: { runId: "run-2", status: "finished", result: "{\"ok\":true}" },
      });
    });

    it("should hydrate terminal stream events from URL-only final payload refs", async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: sseStream([
            {
              runId: "run-3",
              seq: 1,
              type: "end",
              time: 1,
              data: {
                runId: "run-3",
                status: "finished",
                finalPayloadRef: { url: "https://signed.example/final-url-only.json" },
                error: null,
              },
              statusCode: 200,
            },
          ]),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ runId: "run-3", status: "finished", result: "{\"ok\":true}" }),
        });

      const events = [];
      for await (const event of client.streamResumable({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
      })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        runId: "run-3",
        seq: 1,
        type: "end",
        data: { runId: "run-3", status: "finished", result: "{\"ok\":true}" },
      });
      expect(mockFetch).toHaveBeenCalledWith("https://signed.example/final-url-only.json");
    });

    it("should abort terminal payload hydration", async () => {
      const controller = new AbortController();
      let payloadSignal: AbortSignal | null | undefined;
      let markPayloadFetchStarted!: () => void;
      const payloadFetchStarted = new Promise<void>((resolve) => {
        markPayloadFetchStarted = resolve;
      });
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: sseStream([
            {
              runId: "run-final-abort",
              seq: 1,
              type: "end",
              time: 1,
              data: {
                runId: "run-final-abort",
                status: "finished",
                finalPayloadRef: { url: "https://signed.example/final-abort.json" },
              },
              statusCode: 200,
            },
          ]),
        })
        .mockImplementationOnce((_url, init?: RequestInit) => {
          payloadSignal = init?.signal;
          markPayloadFetchStarted();
          return new Promise((_resolve, reject) => {
            payloadSignal?.addEventListener("abort", () => reject(payloadSignal?.reason), { once: true });
          });
        });

      const nextEvent = client.streamResumable({
        recipeId: "test-recipe",
        entryId: "test-entry",
        body: { message: "Hello!" },
        signal: controller.signal,
      })[Symbol.asyncIterator]().next();

      await payloadFetchStarted;
      expect(payloadSignal).toBe(controller.signal);
      controller.abort(new DOMException("Stopped during final hydration", "AbortError"));
      await expect(nextEvent).rejects.toMatchObject({
        name: "AbortError",
        message: "Stopped during final hydration",
      });
    });
  });

  describe("authorization", () => {
    const jsonResponse = (data: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Unauthorized",
      headers: new Headers(),
      text: async () => JSON.stringify(data),
    });

    it("acquires bearer tokens immediately and protects auth headers from overrides", async () => {
      const getToken = vi.fn().mockResolvedValue("raw-token");
      client = new KitchenClient({
        authorization: { kind: "bearer", getToken },
        entryPoint: "raydev",
      });
      mockFetch.mockResolvedValueOnce(jsonResponse({ status: "finished" }));

      await client.sync({
        recipeId: "recipe",
        entryId: "entry",
        body: {},
        headers: {
          Authorization: "stale-token",
          "x-entry-auth-code": "stale-code",
          "X-Custom": "custom",
        },
      });

      expect(getToken).toHaveBeenCalledTimes(1);
      expect(getToken).toHaveBeenCalledWith({ forceRefresh: false });
      expect(mockFetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        headers: {
          "Content-Type": "application/json",
          "X-Custom": "custom",
          Authorization: "raw-token",
        },
      }));
    });

    it("passes stream cancellation to bearer token acquisition", async () => {
      const controller = new AbortController();
      let tokenSignal: AbortSignal | undefined;
      let markTokenRequested!: () => void;
      const tokenRequested = new Promise<void>((resolve) => {
        markTokenRequested = resolve;
      });
      const getToken = vi.fn(({ signal }: { forceRefresh: boolean; signal?: AbortSignal }) => {
        tokenSignal = signal;
        markTokenRequested();
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      });
      client = new KitchenClient({ authorization: { kind: "bearer", getToken } });

      const consuming = (async () => {
        for await (const _event of client.stream({
          recipeId: "recipe",
          entryId: "entry",
          body: {},
          signal: controller.signal,
        })) {
          // Token acquisition remains pending until cancellation.
        }
      })();

      await tokenRequested;
      expect(tokenSignal).toBe(controller.signal);
      controller.abort(new DOMException("Stopped before authorization", "AbortError"));
      await expect(consuming).rejects.toMatchObject({
        name: "AbortError",
        message: "Stopped before authorization",
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refreshes and retries exactly once after an HTTP 401", async () => {
      const getToken = vi.fn()
        .mockResolvedValueOnce("expired-token")
        .mockResolvedValueOnce("fresh-token");
      client = new KitchenClient({ authorization: { kind: "bearer", getToken } });
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ status: "error", error: "unauthorized" }, 401))
        .mockResolvedValueOnce(jsonResponse({ status: "finished", result: "ok" }));

      const result = await client.sync({ recipeId: "recipe", entryId: "entry", body: {} });

      expect(result.status).toBe("finished");
      expect(getToken.mock.calls).toEqual([[{ forceRefresh: false }], [{ forceRefresh: true }]]);
      expect(mockFetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "expired-token" }),
      }));
      expect(mockFetch.mock.calls[1]?.[1]).toEqual(expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "fresh-token" }),
      }));
    });

    it("refreshes on the exact runner authorization-expired payload", async () => {
      const getToken = vi.fn()
        .mockResolvedValueOnce("expired-token")
        .mockResolvedValueOnce("fresh-token");
      client = new KitchenClient({ authorization: { kind: "bearer", getToken } });
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ runId: null, status: "error", error: "Authorization expired or invalid" }, 400))
        .mockResolvedValueOnce(jsonResponse({ status: "finished" }));

      await client.sync({ recipeId: "recipe", entryId: "entry", body: {} });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(getToken).toHaveBeenCalledTimes(2);
      expect(getToken).toHaveBeenLastCalledWith({ forceRefresh: true });
    });

    it("does not refresh generic permission failures or a response with a run identity", async () => {
      const getToken = vi.fn().mockResolvedValue("token");
      client = new KitchenClient({ authorization: { kind: "bearer", getToken } });

      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, 403));
      const forbidden = await client.sync({ recipeId: "recipe", entryId: "entry", body: {} });
      expect(forbidden._statusCode).toBe(403);
      expect(getToken).toHaveBeenCalledTimes(1);

      mockFetch.mockResolvedValueOnce(jsonResponse({ runId: "run-1", error: "expired" }, 401));
      const runResponse = await client.sync({ recipeId: "recipe", entryId: "entry", body: {} });
      expect(runResponse._statusCode).toBe(401);
      expect(getToken).toHaveBeenCalledTimes(2);
    });

    it("surfaces a safe error when the token provider fails", async () => {
      const getToken = vi.fn().mockRejectedValue(new Error("secret-token should not leak"));
      client = new KitchenClient({ authorization: { kind: "bearer", getToken } });

      await expect(client.sync({ recipeId: "recipe", entryId: "entry", body: {} }))
        .rejects.toMatchObject({
          name: "KitchenAuthorizationError",
          code: "KITCHEN_AUTHORIZATION_ERROR",
          message: expect.not.stringContaining("secret-token"),
        });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("refreshes an initial stream when the runner sends an auth error before any run event", async () => {
      const getToken = vi.fn()
        .mockResolvedValueOnce("expired-token")
        .mockResolvedValueOnce("fresh-token");
      client = new KitchenClient({ authorization: { kind: "bearer", getToken } });
      const abandonedBody = sseStream([{
        runId: null,
        type: "end",
        time: 1,
        data: { runId: null, status: "error", error: "Authorization expired or invalid" },
        statusCode: 400,
      }]);
      const cancelAbandonedBody = vi.spyOn(abandonedBody, "cancel");
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: abandonedBody,
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: sseStream([
            { runId: "run-1", type: "progress", time: 2, data: {}, statusCode: 200 },
            { runId: "run-1", type: "end", time: 3, data: { status: "finished" }, statusCode: 200 },
          ]),
        });

      const events: StreamEvent[] = [];
      for await (const event of client.stream({ recipeId: "recipe", entryId: "entry", body: {} })) {
        events.push(event);
      }

      expect(events.map((event) => event.type)).toEqual(["progress", "end"]);
      expect(getToken.mock.calls).toEqual([[{ forceRefresh: false }], [{ forceRefresh: true }]]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(cancelAbandonedBody).toHaveBeenCalledTimes(1);
    });

    it("cancels only the abandoned body and bounds initial stream auth recovery to one retry", async () => {
      const getToken = vi.fn()
        .mockResolvedValueOnce("expired-token")
        .mockResolvedValueOnce("still-expired-token");
      client = new KitchenClient({ authorization: { kind: "bearer", getToken } });
      const authEvent: StreamEvent = {
        runId: null,
        type: "end",
        time: 1,
        data: { error: "Authorization expired or invalid" },
        statusCode: 400,
      };
      const abandonedBody = sseStream([authEvent]);
      const surfacedBody = sseStream([{ ...authEvent, time: 2 }]);
      const cancelAbandonedBody = vi.spyOn(abandonedBody, "cancel");
      const cancelSurfacedBody = vi.spyOn(surfacedBody, "cancel");
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200, body: abandonedBody })
        .mockResolvedValueOnce({ ok: true, status: 200, body: surfacedBody });

      const events: StreamEvent[] = [];
      for await (const event of client.stream({ recipeId: "recipe", entryId: "entry", body: {} })) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]?.data).toEqual({ error: "Authorization expired or invalid" });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(getToken.mock.calls).toEqual([[{ forceRefresh: false }], [{ forceRefresh: true }]]);
      expect(cancelAbandonedBody).toHaveBeenCalledTimes(1);
      expect(cancelSurfacedBody).not.toHaveBeenCalled();
    });

    it("cancels an abandoned resumed-stream body before retrying the same run", async () => {
      const getToken = vi.fn()
        .mockResolvedValueOnce("expired-token")
        .mockResolvedValueOnce("fresh-token");
      client = new KitchenClient({ authorization: { kind: "bearer", getToken } });
      const abandonedBody = sseStream([{
        runId: null,
        type: "end",
        time: 1,
        data: { error: "Authorization expired or invalid" },
        statusCode: 400,
      }]);
      const cancelAbandonedBody = vi.spyOn(abandonedBody, "cancel");
      mockFetch
        .mockResolvedValueOnce({ ok: true, status: 200, body: abandonedBody })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: sseStream([{
            runId: "run-1",
            type: "end",
            time: 2,
            data: { status: "finished" },
            statusCode: 200,
          }]),
        });

      const events: StreamEvent[] = [];
      for await (const event of client.resumePipelineRunStream("run-1")) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ runId: "run-1", type: "end" });
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0]?.[0]).toContain("/resumestream/run-1?");
      expect(mockFetch.mock.calls[1]?.[0]).toContain("/resumestream/run-1?");
      expect(getToken.mock.calls).toEqual([[{ forceRefresh: false }], [{ forceRefresh: true }]]);
      expect(cancelAbandonedBody).toHaveBeenCalledTimes(1);
    });

    it("does not create another stream after a meaningful event", async () => {
      const getToken = vi.fn().mockResolvedValue("token");
      client = new KitchenClient({ authorization: { kind: "bearer", getToken } });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: sseStream([
          { runId: "run-1", type: "progress", time: 1, data: {}, statusCode: 200 },
          { runId: null, type: "end", time: 2, data: { error: "Authorization expired or invalid" }, statusCode: 400 },
        ]),
      });

      const events: StreamEvent[] = [];
      for await (const event of client.stream({ recipeId: "recipe", entryId: "entry", body: {} })) {
        events.push(event);
      }

      expect(events.map((event) => event.type)).toEqual(["progress", "end"]);
      expect(getToken).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("acquires a token for every poll attempt", async () => {
      const getToken = vi.fn()
        .mockResolvedValueOnce("token-1")
        .mockResolvedValueOnce("token-2");
      client = new KitchenClient({ authorization: { kind: "bearer", getToken } });
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ pipelineRun: { runId: "run-1", status: "running" } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ pipelineRun: { runId: "run-1", status: "finished" } }),
        });

      await client.getPipelineRun("run-1");
      await client.getPipelineRun("run-1");
      expect(getToken.mock.calls).toEqual([[{ forceRefresh: false }], [{ forceRefresh: false }]]);
    });
  });

  describe("URL construction", () => {
    it("should construct correct URL for entry point 'entry'", async () => {
      client = new KitchenClient({
        authorization: { kind: "entry_code", code: "test-code" },
        entryPoint: "entry",
      });

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
      client = new KitchenClient({
        authorization: { kind: "entry_code", code: "test-code" },
        entryPoint: "beta",
      });

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
