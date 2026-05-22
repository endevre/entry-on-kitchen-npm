import type {
  KitchenClientConfig,
  KitchenResponse,
  SyncParams,
  StreamParams,
  StreamEvent,
  HttpResponse,
  DeltaOperation,
  OverrideAPIKey,
  RunWithToolsParams,
  LLMToolResult,
  PipelineRunEventsResponse,
  PipelineRunFinalPayloadRef,
  PipelineRunStatus,
  ResumableStreamParams,
} from "./types";
import {
  createToolError,
  createToolResult,
  getToolCallRequest,
  withToolResults,
  withTools,
} from "./tools";

type HeadersObject = Record<string, string>;

/**
 * Apply delta operations to a string
 *
 * @param original - The original string
 * @param delta - List of delta operations
 * @returns The modified string
 *
 * @example
 * ```ts
 * const text = "Hello";
 * const ops: DeltaOperation[] = [["i", 5, " World"]];
 * KitchenClient.applyDelta(text, ops); // "Hello World"
 * ```
 */
export function applyDelta(original: string, delta: DeltaOperation[]): string {
  let result = original.split("");
  let offset = 0;

  for (const operation of delta) {
    const opType = operation[0];

    if (opType === "d") {
      // Delete operation
      const position = operation[1] + offset;
      // operation can be ["d", position] or ["d", position, length]
      const length = operation.length === 3 ? (operation[2] as number) : 1;

      // Delete characters at position
      result.splice(position, length);
      offset -= length;
    } else if (opType === "i") {
      // Insert operation
      const position = operation[1] + offset;
      const text = operation[2] as string;

      // Insert text at position
      result.splice(position, 0, ...text.split(""));
      offset += text.length;
    }
  }

  return result.join("");
}

/**
 * KitchenClient - Entry on Kitchen API Client
 *
 * Provides a simple interface for executing recipes on the Entry on Kitchen API.
 * Supports both synchronous execution and real-time streaming.
 *
 * @example
 * ```ts
 * const client = new KitchenClient({
 *   authCode: "your-auth-code",
 *   entryPoint: "beta"
 * });
 *
 * // Synchronous execution
 * const result = await client.sync({
 *   recipeId: "abc123",
 *   entryId: "def456",
 *   body: { message: "Hello!" }
 * });
 *
 * // Streaming execution
 * for await (const event of client.stream({
 *   recipeId: "abc123",
 *   entryId: "def456",
 *   body: { message: "Hello!" }
 * })) {
 *   console.log(event.type, event.data);
 * }
 * ```
 */
export class KitchenClient {
  private readonly authCode: string;
  private readonly entryPoint: string;
  private readonly useAuthorizationHeader: boolean;

  /**
   * Create a new KitchenClient instance
   *
   * @param config - Client configuration
   * @throws {Error} If authCode is not provided
   */
  constructor(config: KitchenClientConfig) {
    const { authCode, entryPoint = "entry", useAuthorizationHeader = false } = config;

    if (!authCode) {
      throw new Error("authCode is required");
    }

    this.authCode = authCode;
    this.entryPoint = entryPoint;
    this.useAuthorizationHeader = useAuthorizationHeader;
  }

  /**
   * Get the base URL for API requests
   *
   * Supports two formats:
   * 1. Full URL (e.g., "https://entry.on.kitchen") - used as-is
   * 2. Stage name (e.g., "beta", "raydev") - converted to "https://beta.entry.on.kitchen"
   */
  private getBaseUrl(): string {
    if (!this.entryPoint) {
      return "https://entry.on.kitchen";
    }

    // Check if entryPoint is already a full URL
    if (this.entryPoint.startsWith("http://") || this.entryPoint.startsWith("https://")) {
      return this.entryPoint;
    }

    // Otherwise, treat it as a stage/subdomain name
    return `https://${this.entryPoint}.entry.on.kitchen`;
  }

  private getApiBaseUrl(): string {
    if (!this.entryPoint || this.entryPoint === "entry") {
      return "https://api.on.kitchen";
    }

    if (this.entryPoint.startsWith("http://") || this.entryPoint.startsWith("https://")) {
      const url = new URL(this.entryPoint);
      if (url.hostname === "entry.on.kitchen" || url.hostname === "entry.entry.on.kitchen") {
        url.hostname = "api.on.kitchen";
      } else if (url.hostname.endsWith(".entry.on.kitchen")) {
        url.hostname = url.hostname.replace(".entry.on.kitchen", ".api.on.kitchen");
      }
      return url.toString().replace(/\/$/, "");
    }

    return `https://${this.entryPoint}.api.on.kitchen`;
  }

  /**
   * Get standard headers for API requests
   */
  private getHeaders(customHeaders?: Record<string, string>): HeadersObject {
    const headers: HeadersObject = {
      "Content-Type": "application/json",
    };

    if (this.useAuthorizationHeader) {
      headers["Authorization"] = this.authCode;
    } else {
      headers["X-Entry-Auth-Code"] = this.authCode;
    }

    // Merge custom headers (they can override defaults if needed)
    if (customHeaders) {
      Object.assign(headers, customHeaders);
    }

    return headers;
  }

  /**
   * Prepare the request body
   */
  private prepareBody(
    body: unknown,
    useKitchenBilling?: boolean,
    llmOverride?: string,
    apiKeyOverride?: OverrideAPIKey
  ): string {
    let bodyObj = typeof body === "string" ? JSON.parse(body) : body;

    // Add KITCHEN_BILLING_OVERRIDE if specified
    if (useKitchenBilling) {
      bodyObj = {
        ...((bodyObj as Record<string, unknown>) || {}),
        KITCHEN_BILLING_OVERRIDE: true,
      };
    }

    // Add KITCHEN_MODELS_OVERRIDE if llmOverride is specified
    if (llmOverride) {
      const existingModelOverrides =
        bodyObj &&
        typeof bodyObj === "object" &&
        "KITCHEN_MODELS_OVERRIDE" in (bodyObj as Record<string, unknown>) &&
        typeof (bodyObj as Record<string, unknown>).KITCHEN_MODELS_OVERRIDE === "object"
          ? ((bodyObj as Record<string, unknown>).KITCHEN_MODELS_OVERRIDE as Record<string, unknown>)
          : {};

      bodyObj = {
        ...((bodyObj as Record<string, unknown>) || {}),
        KITCHEN_MODELS_OVERRIDE: {
          ...existingModelOverrides,
          models__llm_override: llmOverride,
        },
      };
    }

    // Add KITCHEN_APIKEYS_OVERRIDE if apiKeyOverride is specified
    if (apiKeyOverride && Object.keys(apiKeyOverride).length > 0) {
      bodyObj = {
        ...((bodyObj as Record<string, unknown>) || {}),
        KITCHEN_APIKEYS_OVERRIDE: apiKeyOverride,
      };
    }

    return JSON.stringify(bodyObj);
  }

  /**
   * Make an HTTP request using native fetch
   */
  private async httpRequest(
    url: string,
    body: string,
    customHeaders?: Record<string, string>,
  ): Promise<HttpResponse> {
    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(customHeaders),
      body,
    });

    const data = await this.parseResponse(response);

    return {
      data,
      status: response.status,
      statusText: response.statusText,
    };
  }

  /**
   * Parse response JSON gracefully
   */
  private async parseResponse(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
      return "";
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      method: "GET",
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json() as T;
  }

  private parseSseFrame(frame: string): StreamEvent | null {
    const dataLines: string[] = [];
    for (const rawLine of frame.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    const data = dataLines.join("\n").trim();
    if (!data) return null;
    try {
      return JSON.parse(data) as StreamEvent;
    } catch {
      return null;
    }
  }

  private async *readSseResponse(response: Response): AsyncIterable<StreamEvent> {
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
        }

        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(buffer[boundary] === "\r" ? boundary + 4 : boundary + 2);
          const event = this.parseSseFrame(frame);
          if (event) yield event;
          boundary = buffer.search(/\r?\n\r?\n/);
        }

        if (done) {
          const event = this.parseSseFrame(buffer);
          if (event) yield event;
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Execute a recipe synchronously
   *
   * @param params - Sync execution parameters
   * @returns Promise resolving to the response
   *
   * @example
   * ```ts
   * const result = await client.sync({
   *   recipeId: "abc123",
   *   entryId: "def456",
   *   body: { message: "Hello!" }
   * });
   *
   * if (result._statusCode && result._statusCode !== 200) {
   *   console.error("Error:", result.error);
   * } else {
   *   console.log("Result:", result.result);
   * }
   * ```
   */
  async sync(params: SyncParams): Promise<KitchenResponse> {
    const { recipeId, entryId, body, useKitchenBilling, llmOverride, apiKeyOverride, headers } = params;
    const url = `${this.getBaseUrl()}/${recipeId}/${entryId}/sync`;
    const stringifiedBody = this.prepareBody(body, useKitchenBilling, llmOverride, apiKeyOverride);

    const response = await this.httpRequest(url, stringifiedBody, headers);

    // If we got an error response, return it with status code
    if (response.status !== 200) {
      return {
        ...(response.data as KitchenResponse),
        _statusCode: response.status,
      };
    }

    return response.data as KitchenResponse;
  }

  /**
   * Execute a recipe and automatically satisfy external LLM tool calls.
   *
   * This helper repeatedly runs the same entry with tool results until Kitchen
   * returns a completed response or the iteration limit is reached.
   */
  async runWithTools(params: RunWithToolsParams): Promise<KitchenResponse> {
    const {
      tools,
      handlers,
      maxToolIterations = 5,
      onToolCall,
      onToolResult,
      body,
      ...syncParams
    } = params;

    let currentBody: unknown = withTools(body, tools);
    let lastResponse: KitchenResponse | null = null;

    for (let iteration = 0; iteration < maxToolIterations; iteration++) {
      const response = await this.sync({
        ...syncParams,
        body: currentBody,
      });
      lastResponse = response;

      const request = getToolCallRequest(response);
      if (!request) {
        return response;
      }

      const toolResults: LLMToolResult[] = [];
      for (const toolCall of request.tool_calls) {
        if (onToolCall) {
          await onToolCall(toolCall);
        }

        const handler = handlers[toolCall.name];
        let toolResult: LLMToolResult;
        if (!handler) {
          toolResult = createToolError({
            toolCallId: toolCall.id,
            name: toolCall.name,
            message: `No handler registered for tool '${toolCall.name}'`,
            code: "HANDLER_NOT_FOUND",
          });
        } else {
          try {
            const output = await handler(toolCall.arguments || {}, toolCall);
            toolResult = createToolResult({
              toolCallId: toolCall.id,
              name: toolCall.name,
              output,
            });
          } catch (error) {
            toolResult = createToolError({
              toolCallId: toolCall.id,
              name: toolCall.name,
              message: error instanceof Error ? error.message : String(error),
              code: "HANDLER_ERROR",
            });
          }
        }

        if (onToolResult) {
          await onToolResult(toolResult);
        }
        toolResults.push(toolResult);
      }

      currentBody = withToolResults(body, toolResults, request.continuation);
    }

    return {
      ...(lastResponse || { status: "error" }),
      status: "error",
      error: `Maximum tool iterations reached (${maxToolIterations})`,
    };
  }

  async getPipelineRun(runId: string): Promise<PipelineRunStatus> {
    const response = await this.fetchJson<{ pipelineRun: PipelineRunStatus }>(
      `${this.getApiBaseUrl()}/pipelineruns/${runId}`,
    );
    return response.pipelineRun;
  }

  async getPipelineRunEvents(
    runId: string,
    options: { after?: number; limit?: number } = {},
  ): Promise<PipelineRunEventsResponse> {
    const params = new URLSearchParams();
    if (options.after !== undefined) params.set("after", String(options.after));
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    return await this.fetchJson<PipelineRunEventsResponse>(
      `${this.getApiBaseUrl()}/pipelineruns/${runId}/events${query ? `?${query}` : ""}`,
    );
  }

  async fetchPipelineRunFinalPayload(ref: PipelineRunFinalPayloadRef): Promise<KitchenResponse> {
    if (!ref?.url) {
      throw new Error("Final payload reference does not include a URL");
    }
    const response = await fetch(ref.url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json() as KitchenResponse;
  }

  async *resumePipelineRunStream(
    runId: string,
    options: { after?: number } = {},
  ): AsyncIterable<StreamEvent> {
    const params = new URLSearchParams();
    params.set("after", String(options.after || 0));
    const response = await fetch(`${this.getBaseUrl()}/resumestream/${runId}?${params.toString()}`, {
      method: "GET",
      headers: this.getHeaders(),
    });
    yield* this.readSseResponse(response);
  }

  private isFinalPayloadRef(value: unknown): value is PipelineRunFinalPayloadRef {
    return Boolean(
      value &&
        typeof value === "object" &&
        "bucket" in value &&
        "key" in value,
    );
  }

  private async hydrateTerminalEvent(event: StreamEvent): Promise<StreamEvent> {
    if (event.type !== "end" && event.type !== "error") {
      return event;
    }

    const data = event.data;
    if (!data || typeof data !== "object") {
      return event;
    }

    const dataRecord = data as Record<string, unknown>;
    const hasInlinePayload = "result" in dataRecord || "error" in dataRecord || "exitBlock" in dataRecord;
    const ref = dataRecord.finalPayloadRef;
    if (hasInlinePayload || !this.isFinalPayloadRef(ref)) {
      return event;
    }

    return {
      ...event,
      data: await this.fetchPipelineRunFinalPayload(ref),
    };
  }

  /**
   * Execute or resume a streamed recipe run.
   *
   * If runId is provided, the stream starts by replaying events after afterSeq and
   * then follows live Mongo change-stream events. If runId is omitted, this starts
   * a normal stream and records the runId/seq callbacks once the runner emits them.
   */
  async *streamResumable(params: ResumableStreamParams): AsyncIterable<StreamEvent> {
    const {
      runId: initialRunId,
      afterSeq = 0,
      onRunId,
      onSeq,
      maxReconnects = 3,
      ...streamParams
    } = params;

    let runId = initialRunId;
    let lastSeq = afterSeq;
    let reconnects = 0;
    let source: AsyncIterable<StreamEvent> = runId
      ? this.resumePipelineRunStream(runId, { after: lastSeq })
      : this.stream(streamParams);

    const remember = (event: StreamEvent) => {
      if (event.runId && event.runId !== runId) {
        runId = event.runId;
        onRunId?.(runId);
      }

      if (typeof event.seq === "number" && event.seq > lastSeq) {
        lastSeq = event.seq;
        onSeq?.(lastSeq, event);
      }
    };

    while (true) {
      try {
        for await (const rawEvent of source) {
          const event = await this.hydrateTerminalEvent(rawEvent);
          remember(event);
          yield event;

          if (event.type === "end" || event.type === "error") {
            return;
          }
        }
        return;
      } catch (error) {
        if (!runId || reconnects >= maxReconnects) {
          throw error;
        }

        reconnects += 1;
        const eventSnapshot = await this.getPipelineRunEvents(runId, { after: lastSeq });
        for (const rawEvent of eventSnapshot.events) {
          const event = await this.hydrateTerminalEvent(rawEvent);
          remember(event);
          yield event;

          if (event.type === "end" || event.type === "error") {
            return;
          }
        }

        const status = await this.getPipelineRun(runId);
        if (status.status !== "running") {
          const terminalType = status.status === "finished" ? "end" : "error";
          const finalPayload = status.finalPayloadRef
            ? await this.fetchPipelineRunFinalPayload(status.finalPayloadRef)
            : status;
          const finalSeq =
            typeof status.stream?.finalSeq === "number"
              ? status.stream.finalSeq
              : lastSeq;

          const terminalEvent: StreamEvent = {
            runId,
            seq: finalSeq,
            type: terminalType,
            time: Date.now(),
            data: finalPayload,
            statusCode: terminalType === "end" ? 200 : 500,
          };

          remember(terminalEvent);
          yield terminalEvent;
          return;
        }

        source = this.resumePipelineRunStream(runId, { after: lastSeq });
      }
    }
  }

  /**
   * Execute a recipe with streaming responses
   *
   * Yields events as they arrive from the server.
   *
   * @param params - Stream execution parameters
   * @returns Async iterable of stream events
   *
   * @example
   * ```ts
   * for await (const event of client.stream({
   *   recipeId: "abc123",
   *   entryId: "def456",
   *   body: { message: "Hello!" }
   * })) {
   *   if (event.type === "progress") {
   *     console.log("Progress:", event.data);
   *   } else if (event.type === "result") {
   *     console.log("Result:", event.data);
   *   } else if (event.type === "end") {
   *     console.log("Complete!");
   *   }
   * }
   * ```
   */
  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const { recipeId, entryId, body, useKitchenBilling, llmOverride, apiKeyOverride, headers } = params;
    const url = `${this.getBaseUrl()}/${recipeId}/${entryId}/stream`;
    const stringifiedBody = this.prepareBody(body, useKitchenBilling, llmOverride, apiKeyOverride);

    const response = await fetch(url, {
      method: "POST",
      headers: this.getHeaders(headers),
      body: stringifiedBody,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    // The API returns either:
    // 1. Server-Sent Events with "data:" prefix: data:{...}data:{...}
    // 2. Raw concatenated JSON objects: {...}{...}{...}
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    // Helper function to extract complete JSON objects from buffer
    function extractCompleteJsonObjects(input: string): string[] {
      const objects: string[] = [];
      let depth = 0;
      let inString = false;
      let escapeNext = false;
      let startIdx = -1;

      for (let i = 0; i < input.length; i++) {
        const char = input[i];

        if (escapeNext) {
          escapeNext = false;
          continue;
        }

        if (char === "\\") {
          escapeNext = true;
          continue;
        }

        if (char === '"') {
          inString = !inString;
          continue;
        }

        if (!inString) {
          if (char === "{") {
            if (depth === 0) {
              startIdx = i;
            }
            depth++;
          } else if (char === "}") {
            depth--;
            if (depth === 0 && startIdx !== -1) {
              objects.push(input.substring(startIdx, i + 1));
              startIdx = -1;
            }
          }
        }
      }

      return objects;
    }

    try {
      while (true) {
        const { done, value } = await reader.read();

        // Decode chunk and accumulate
        if (value) {
          buffer += decoder.decode(value, { stream: true });
        }

        if (done) {
          // Process any remaining data in buffer
          if (buffer.trim()) {
            // Try SSE format first
            const lines = buffer.split("data:");
            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine) {
                continue;
              }

              try {
                const obj = JSON.parse(trimmedLine);
                yield obj as StreamEvent;
              } catch {
                // Try concatenated format
                const objects = extractCompleteJsonObjects(trimmedLine);
                for (const objStr of objects) {
                  try {
                    const obj = JSON.parse(objStr);
                    yield obj as StreamEvent;
                  } catch {
                    // Skip invalid JSON
                  }
                }
              }
            }
          }
          break;
        }

        // Try to parse and yield complete objects as they arrive
        // SSE format: split by "data:" and try to parse each complete line
        if (buffer.includes("data:")) {
          const lines = buffer.split("data:");
          let allButLastComplete = true;

          // Check if the last line is complete (ends with } or ])
          const lastLine = lines[lines.length - 1];
          const lastLineTrimmed = lastLine.trim();
          if (lastLineTrimmed && !lastLineTrimmed.endsWith("}") && !lastLineTrimmed.endsWith("]")) {
            allButLastComplete = false;
          }

          // Process all complete lines
          const linesToProcess = allButLastComplete ? lines.length : lines.length - 1;
          let processedChars = 0;

          for (let i = 0; i < linesToProcess; i++) {
            const line = lines[i].trim();
            if (line) {
              try {
                const obj = JSON.parse(line);
                yield obj as StreamEvent;
              } catch {
                // Try concatenated format
                const objects = extractCompleteJsonObjects(line);
                for (const objStr of objects) {
                  try {
                    const obj = JSON.parse(objStr);
                    yield obj as StreamEvent;
                  } catch {
                    // Skip invalid JSON
                  }
                }
              }
            }
            processedChars += line.length + 5; // +5 for "data:"
          }

          // Remove processed data from buffer
          if (processedChars > 0 && processedChars < buffer.length) {
            buffer = buffer.substring(processedChars);
          } else if (linesToProcess === lines.length) {
            buffer = "";
          }
        } else {
          // No SSE format, try concatenated JSON
          const objects = extractCompleteJsonObjects(buffer);
          let lastEndIdx = 0;

          for (const objStr of objects) {
            try {
              const obj = JSON.parse(objStr);
              yield obj as StreamEvent;
              lastEndIdx += objStr.length;
            } catch {
              // Skip invalid JSON
            }
          }

          // Keep unprocessed data in buffer
          buffer = buffer.substring(lastEndIdx);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

}
