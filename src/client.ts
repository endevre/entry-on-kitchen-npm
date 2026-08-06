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
  AgentRunMetadata,
  ThinkingLevel,
  KitchenAuthorization,
} from "./types";
import {
  createToolError,
  createToolResult,
  getToolCallRequest,
  withToolResults,
  withTools,
} from "./tools";

type HeadersObject = Record<string, string>;

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "low", "medium", "high", "xhigh", "max"]);
const AUTHORIZATION_EXPIRED_MESSAGE = "Authorization expired or invalid";

/** A safe error raised when a bearer provider cannot supply a usable token. */
export class KitchenAuthorizationError extends Error {
  readonly code = "KITCHEN_AUTHORIZATION_ERROR";

  constructor(message = "Unable to obtain authorization for the Kitchen request") {
    super(message);
    this.name = "KitchenAuthorizationError";
  }
}

function normalizeThinkingOverride(value: ThinkingLevel | undefined): ThinkingLevel | undefined {
  if (value === undefined || value === null || String(value).trim() === "") {
    return undefined;
  }

  const normalized = String(value).trim().toLowerCase() as ThinkingLevel;
  if (!THINKING_LEVELS.has(normalized)) {
    throw new Error(
      "Invalid thinkingOverride. Expected one of: off, low, medium, high, xhigh, max",
    );
  }
  return normalized;
}

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
 *   authorization: { kind: "entry_code", code: "your-auth-code" },
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
  private readonly authorization: KitchenAuthorization;
  private readonly entryPoint: string;

  /**
   * Create a new KitchenClient instance
   *
   * @param config - Client configuration
   * @throws {Error} If authorization is missing or malformed
   */
  constructor(config: KitchenClientConfig) {
    const { authorization, entryPoint = "entry" } = config || {};

    if (!authorization) {
      throw new Error("authorization is required");
    }

    if (authorization.kind === "entry_code") {
      if (!authorization.code || typeof authorization.code !== "string") {
        throw new Error("authorization.code is required for entry_code authorization");
      }
    } else if (authorization.kind === "bearer") {
      if (typeof authorization.getToken !== "function") {
        throw new Error("authorization.getToken is required for bearer authorization");
      }
    } else {
      throw new Error("authorization.kind must be entry_code or bearer");
    }

    this.authorization = authorization;
    this.entryPoint = entryPoint;
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

  private isAuthorizationHeader(name: string): boolean {
    const normalized = name.toLowerCase();
    return normalized === "authorization" || normalized === "x-entry-auth-code";
  }

  private async getAuthorizationValue(forceRefresh = false): Promise<HeadersObject> {
    if (this.authorization.kind === "entry_code") {
      return { "X-Entry-Auth-Code": this.authorization.code };
    }

    let token: string;
    try {
      token = await this.authorization.getToken({ forceRefresh });
    } catch {
      throw new KitchenAuthorizationError();
    }

    if (typeof token !== "string" || token.trim() === "") {
      throw new KitchenAuthorizationError();
    }

    // The provider owns the wire format. Preserve raw values and do not add a
    // Bearer prefix because some Kitchen deployments use another scheme.
    return { Authorization: token };
  }

  /**
   * Get standard headers for API requests. Authentication headers are always
   * written last so caller-provided headers cannot replace them.
   */
  private async getHeaders(
    customHeaders?: Record<string, string>,
    forceRefresh = false,
  ): Promise<HeadersObject> {
    const headers: HeadersObject = {
      "Content-Type": "application/json",
    };

    if (customHeaders) {
      for (const [name, value] of Object.entries(customHeaders)) {
        if (!this.isAuthorizationHeader(name)) {
          headers[name] = value;
        }
      }
    }

    Object.assign(headers, await this.getAuthorizationValue(forceRefresh));
    return headers;
  }

  private getAgentMetadataHeaders(agentMetadata?: AgentRunMetadata): HeadersObject {
    if (!agentMetadata) return {};

    const headers: HeadersObject = {};
    const mappings: Array<[keyof AgentRunMetadata, string]> = [
      ["agentId", "X-Kitchen-Agent-Id"],
      ["agentSessionId", "X-Kitchen-Agent-Session-Id"],
      ["agentRunId", "X-Kitchen-Agent-Run-Id"],
      ["parentRunId", "X-Kitchen-Parent-Run-Id"],
      ["parentToolCallId", "X-Kitchen-Parent-Tool-Call-Id"],
      ["workspaceId", "X-Kitchen-Workspace-Id"],
      ["workspaceVersionId", "X-Kitchen-Workspace-Version-Id"],
      ["idempotencyKey", "X-Kitchen-Idempotency-Key"],
    ];

    for (const [key, header] of mappings) {
      const value = agentMetadata[key];
      if (value !== undefined && value !== null && value !== "") {
        headers[header] = String(value);
      }
    }

    return headers;
  }

  private mergeHeaders(
    customHeaders?: Record<string, string>,
    agentMetadata?: AgentRunMetadata,
  ): HeadersObject | undefined {
    const metadataHeaders = this.getAgentMetadataHeaders(agentMetadata);
    if (!customHeaders && Object.keys(metadataHeaders).length === 0) {
      return undefined;
    }

    return {
      ...metadataHeaders,
      ...(customHeaders || {}),
    };
  }

  /**
   * Prepare the request body
   */
  private prepareBody(
    body: unknown,
    useKitchenBilling?: boolean,
    llmOverride?: string,
    apiKeyOverride?: OverrideAPIKey,
    thinkingOverride?: ThinkingLevel,
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

    // Add KITCHEN_THINKING_OVERRIDE if thinkingOverride is specified
    const normalizedThinking = normalizeThinkingOverride(thinkingOverride);
    if (normalizedThinking) {
      bodyObj = {
        ...((bodyObj as Record<string, unknown>) || {}),
        KITCHEN_THINKING_OVERRIDE: normalizedThinking,
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
    let forceRefresh = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: await this.getHeaders(customHeaders, forceRefresh),
        body,
      });

      const data = await this.parseResponse(response);
      if (attempt === 0 && this.shouldRetryInitialRequest(response.status, data)) {
        forceRefresh = true;
        continue;
      }

      return {
        data,
        status: response.status,
        statusText: response.statusText,
      };
    }

    throw new Error("HTTP request failed");
  }

  /**
   * Parse response JSON gracefully
   */
  private async parseResponse(response: Response): Promise<unknown> {
    if (typeof response.text !== "function") {
      if (typeof response.json === "function") {
        return await response.json();
      }
      return "";
    }
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

  private canRefreshAuthorization(): boolean {
    return this.authorization.kind === "bearer";
  }

  private hasRunIdentity(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (typeof record.runId === "string" && record.runId.trim() !== "") {
      return true;
    }
    return Boolean(record.data && typeof record.data === "object" && this.hasRunIdentity(record.data));
  }

  private isAuthorizationExpiredPayload(value: unknown): boolean {
    if (typeof value === "string") {
      return value.trim() === AUTHORIZATION_EXPIRED_MESSAGE;
    }
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    return record.error === AUTHORIZATION_EXPIRED_MESSAGE ||
      record.error_message === AUTHORIZATION_EXPIRED_MESSAGE;
  }

  private shouldRetryAuthorization(status: number, data: unknown): boolean {
    return status === 401 || this.isAuthorizationExpiredPayload(data);
  }

  private shouldRetryInitialRequest(status: number, data: unknown): boolean {
    return this.canRefreshAuthorization() &&
      this.shouldRetryAuthorization(status, data) &&
      !this.hasRunIdentity(data);
  }

  private async fetchJson<T>(url: string, knownRunId?: string): Promise<T> {
    let forceRefresh = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, {
        method: "GET",
        headers: await this.getHeaders(undefined, forceRefresh),
      });
      const data = await this.parseResponse(response);
      if (response.ok) {
        return data as T;
      }

      const canRetry = this.canRefreshAuthorization() &&
        this.shouldRetryAuthorization(response.status, data) &&
        (Boolean(knownRunId) || !this.hasRunIdentity(data));
      if (attempt === 0 && canRetry) {
        forceRefresh = true;
        continue;
      }

      throw new Error(`HTTP error! status: ${response.status}`);
    }

    throw new Error("HTTP request failed");
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
      const parsed = JSON.parse(data) as unknown;
      if (typeof parsed === "string") {
        return JSON.parse(parsed) as StreamEvent;
      }
      return parsed as StreamEvent;
    } catch {
      return null;
    }
  }

  private parseStreamEvent(value: string): StreamEvent | null {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "string") {
        return JSON.parse(parsed) as StreamEvent;
      }
      return parsed as StreamEvent;
    } catch {
      return null;
    }
  }

  private isAuthorizationFailureEvent(event: StreamEvent): boolean {
    if (event.type !== "end" && event.type !== "error") return false;
    const data = typeof event.data === "string" ? this.parseStreamEvent(event.data) || event.data : event.data;
    if (event.runId || this.hasRunIdentity(data)) return false;
    return this.isAuthorizationExpiredPayload(data);
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

  private async cancelResponseBody(response: Response): Promise<void> {
    if (!response.body) return;
    try {
      await response.body.cancel();
    } catch {
      // Cancellation is cleanup for an abandoned auth response. A browser may
      // already have closed the body, which must not prevent the bounded retry.
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
    const {
      recipeId,
      entryId,
      body,
      useKitchenBilling,
      llmOverride,
      thinkingOverride,
      apiKeyOverride,
      headers,
      agentMetadata,
    } = params;
    const url = `${this.getBaseUrl()}/${recipeId}/${entryId}/sync`;
    const stringifiedBody = this.prepareBody(
      body,
      useKitchenBilling,
      llmOverride,
      apiKeyOverride,
      thinkingOverride,
    );

    const response = await this.httpRequest(url, stringifiedBody, this.mergeHeaders(headers, agentMetadata));

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
      runId,
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
      runId,
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
    let forceRefresh = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${this.getBaseUrl()}/resumestream/${runId}?${params.toString()}`, {
        method: "GET",
        headers: await this.getHeaders(undefined, forceRefresh),
      });

      if (!response.ok) {
        const data = await this.parseResponse(response);
        if (attempt === 0 && this.canRefreshAuthorization() &&
          this.shouldRetryAuthorization(response.status, data)) {
          forceRefresh = true;
          continue;
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      let sawMeaningfulEvent = false;
      let retry = false;
      for await (const event of this.readSseResponse(response)) {
        if (!sawMeaningfulEvent && this.isAuthorizationFailureEvent(event) &&
          attempt === 0 && this.canRefreshAuthorization()) {
          retry = true;
          break;
        }
        sawMeaningfulEvent = true;
        yield await this.hydrateTerminalEvent(event);
      }

      if (retry) {
        await this.cancelResponseBody(response);
        forceRefresh = true;
        continue;
      }
      return;
    }
  }

  private isFinalPayloadRef(value: unknown): value is PipelineRunFinalPayloadRef {
    return Boolean(
      value &&
        typeof value === "object" &&
        (
          ("bucket" in value && "key" in value) ||
          "url" in value
        ),
    );
  }

  private async hydrateTerminalEvent(event: StreamEvent): Promise<StreamEvent> {
    if (event.type !== "end" && event.type !== "error") {
      return event;
    }

    const data =
      typeof event.data === "string"
        ? this.parseStreamEvent(event.data) || event.data
        : event.data;
    if (!data || typeof data !== "object") {
      return data === event.data ? event : { ...event, data };
    }

    const dataRecord = data as Record<string, unknown>;
    const hasInlineError =
      dataRecord.error !== undefined &&
      dataRecord.error !== null &&
      dataRecord.error !== "" &&
      dataRecord.error !== "null";
    const hasInlinePayload = "result" in dataRecord || hasInlineError || "exitBlock" in dataRecord;
    const ref = dataRecord.finalPayloadRef;
    if (hasInlinePayload || !this.isFinalPayloadRef(ref)) {
      return data === event.data ? event : { ...event, data };
    }

    return {
      ...event,
      data: await this.fetchPipelineRunFinalPayload(ref),
    };
  }

  private isPipelineRunActive(status: string | undefined | null): boolean {
    if (!status) return true;
    return ["queued", "pending", "starting", "running", "in_progress"].includes(
      status.toLowerCase(),
    );
  }

  private isTerminalStreamEvent(event: StreamEvent): boolean {
    return event.type === "end" || event.type === "error";
  }

  private buildTerminalEventFromRunStatus(
    runId: string,
    status: PipelineRunStatus,
    data: unknown,
    lastSeq: number,
  ): StreamEvent {
    const terminalType = status.status === "finished" ? "end" : "error";
    const finalSeq =
      typeof status.stream?.finalSeq === "number"
        ? status.stream.finalSeq
        : lastSeq + 1;

    return {
      runId,
      seq: finalSeq,
      type: terminalType,
      time: Date.now(),
      data,
      statusCode: terminalType === "end" ? 200 : 500,
    };
  }

  private async waitForReconnect(delayMs: number): Promise<void> {
    if (delayMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
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
      reconnectDelayMs = 250,
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

    const yieldMissedEventsAndMaybeTerminal = async function* (
      self: KitchenClient,
      activeRunId: string,
    ): AsyncIterable<{ event: StreamEvent; terminal: boolean }> {
      const eventSnapshot = await self.getPipelineRunEvents(activeRunId, { after: lastSeq });
      for (const rawEvent of eventSnapshot.events || []) {
        const event = await self.hydrateTerminalEvent(rawEvent);
        remember(event);
        yield { event, terminal: self.isTerminalStreamEvent(event) };

        if (self.isTerminalStreamEvent(event)) {
          return;
        }
      }

      const status = await self.getPipelineRun(activeRunId);
      if (self.isPipelineRunActive(status.status)) {
        return;
      }

      const finalPayload = status.finalPayloadRef
        ? await self.fetchPipelineRunFinalPayload(status.finalPayloadRef)
        : status;
      const terminalEvent = self.buildTerminalEventFromRunStatus(
        activeRunId,
        status,
        finalPayload,
        lastSeq,
      );

      remember(terminalEvent);
      yield { event: terminalEvent, terminal: true };
    };

    while (true) {
      try {
        let sawTerminal = false;
        for await (const rawEvent of source) {
          const event = await this.hydrateTerminalEvent(rawEvent);
          remember(event);
          yield event;

          if (this.isTerminalStreamEvent(event)) {
            sawTerminal = true;
            return;
          }
        }

        if (sawTerminal) {
          return;
        }

        if (!runId) {
          throw new Error("Resumable stream closed before terminal event and before a runId was emitted");
        }

        if (reconnects >= maxReconnects) {
          throw new Error(
            `Resumable stream closed before terminal event after ${maxReconnects} reconnect attempts for run ${runId}`,
          );
        }

        reconnects += 1;
        for await (const { event, terminal } of yieldMissedEventsAndMaybeTerminal(this, runId)) {
          yield event;
          if (terminal) return;
        }

        await this.waitForReconnect(reconnectDelayMs);
        source = this.resumePipelineRunStream(runId, { after: lastSeq });
      } catch (error) {
        if (!runId || reconnects >= maxReconnects) {
          throw error;
        }

        reconnects += 1;
        for await (const { event, terminal } of yieldMissedEventsAndMaybeTerminal(this, runId)) {
          yield event;
          if (terminal) return;
        }

        await this.waitForReconnect(reconnectDelayMs);
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
  private async *readRecipeStream(response: Response): AsyncIterable<StreamEvent> {
    // The API returns either Server-Sent Events with a "data:" prefix or raw
    // concatenated JSON objects. Keep both formats for compatibility.
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    const extractCompleteJsonObjects = (input: string): string[] => {
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
            if (depth === 0) startIdx = i;
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
    };

    const parseAndYield = async function* (
      self: KitchenClient,
      value: string,
      extractObjects: boolean,
    ): AsyncIterable<StreamEvent> {
      const parsed = self.parseStreamEvent(value);
      if (parsed) {
        yield parsed;
        return;
      }
      if (!extractObjects) return;
      for (const objectString of extractCompleteJsonObjects(value)) {
        const object = self.parseStreamEvent(objectString);
        if (object) yield object;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });

        if (done) {
          if (buffer.trim()) {
            for (const line of buffer.split("data:")) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              yield* parseAndYield(this, trimmed, true);
            }
          }
          break;
        }

        if (buffer.includes("data:")) {
          const lines = buffer.split("data:");
          const lastLine = lines[lines.length - 1].trim();
          const allButLastComplete = !lastLine || lastLine.endsWith("}") || lastLine.endsWith("]");
          const linesToProcess = allButLastComplete ? lines.length : lines.length - 1;
          let processedChars = 0;

          for (let i = 0; i < linesToProcess; i++) {
            const line = lines[i].trim();
            if (line) yield* parseAndYield(this, line, true);
            processedChars += line.length + 5;
          }

          if (processedChars > 0 && processedChars < buffer.length) {
            buffer = buffer.substring(processedChars);
          } else if (linesToProcess === lines.length) {
            buffer = "";
          }
        } else {
          const objects = extractCompleteJsonObjects(buffer);
          let lastEndIdx = 0;
          for (const objectString of objects) {
            const object = this.parseStreamEvent(objectString);
            if (object) {
              yield object;
              lastEndIdx += objectString.length;
            }
          }
          buffer = buffer.substring(lastEndIdx);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async *stream(params: StreamParams): AsyncIterable<StreamEvent> {
    const {
      recipeId,
      entryId,
      body,
      useKitchenBilling,
      llmOverride,
      thinkingOverride,
      apiKeyOverride,
      headers,
      agentMetadata,
    } = params;
    const url = `${this.getBaseUrl()}/${recipeId}/${entryId}/stream`;
    const stringifiedBody = this.prepareBody(
      body,
      useKitchenBilling,
      llmOverride,
      apiKeyOverride,
      thinkingOverride,
    );
    const requestHeaders = this.mergeHeaders(headers, agentMetadata);

    let forceRefresh = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: await this.getHeaders(requestHeaders, forceRefresh),
        body: stringifiedBody,
      });

      if (!response.ok) {
        const data = await this.parseResponse(response);
        if (attempt === 0 && this.shouldRetryInitialRequest(response.status, data)) {
          forceRefresh = true;
          continue;
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      let sawMeaningfulEvent = false;
      let retry = false;
      for await (const event of this.readRecipeStream(response)) {
        if (!sawMeaningfulEvent && attempt === 0 && this.canRefreshAuthorization() &&
          this.isAuthorizationFailureEvent(event)) {
          retry = true;
          break;
        }
        sawMeaningfulEvent = true;
        yield await this.hydrateTerminalEvent(event);
      }

      if (retry) {
        await this.cancelResponseBody(response);
        forceRefresh = true;
        continue;
      }
      return;
    }
  }

}
