/**
 * Response from a sync execution
 */
export interface KitchenResponse {
  /** The execution run ID */
  runId?: string;
  /** Execution status (e.g., "finished", "error") */
  status: string;
  /** The execution result (if successful) */
  result?: unknown;
  /** Error message (if failed) */
  error?: string;
  /** Exit block information */
  exitBlock?: unknown;
  /** HTTP status code (added for error responses) */
  _statusCode?: number;
}

export type JSONSchema = Record<string, unknown>;

export interface KitchenExternalTool {
  type: "KitchenTool";
  version: 1;
  name: string;
  description: string;
  input_schema: JSONSchema;
  executor: {
    type: "external";
  };
}

export interface KitchenEntryTool {
  type: "KitchenTool";
  version: 1;
  name: string;
  description: string;
  input_schema: JSONSchema;
  executor: {
    type: "entry";
    pipelineId: string;
    entryBlockId: string;
    output_mode?: "full_exit" | "selected_output" | "text";
    selected_output?: string;
  };
}

export type KitchenTool = KitchenExternalTool | KitchenEntryTool;

export interface LLMToolCall {
  type: "LLMToolCall";
  version: 1;
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  tool_type?: "external" | "entry" | string;
  provider?: string;
  raw?: unknown;
}

export interface LLMToolResult {
  type: "LLMToolResult";
  version: 1;
  tool_call_id: string;
  name: string;
  status: "success" | "error";
  output?: unknown;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

export interface LLMContinuation {
  type: "LLMContinuation";
  version: 1;
  provider: string;
  model: string;
  conversation: unknown[];
  provider_state?: Record<string, unknown>;
  tools?: KitchenTool[];
  iteration?: number;
}

export interface ToolCallRequest {
  status: "requires_tool_outputs";
  tool_calls: LLMToolCall[];
  continuation: LLMContinuation;
  tool_results?: LLMToolResult[];
  content?: string;
  message?: unknown;
}

/**
 * Stream event types
 */
export type StreamEventType = "start" | "progress" | "result" | "delta" | "info" | "debug" | "mock" | "end" | "error";

/**
 * Progress event data
 */
export interface ProgressData {
  message?: string;
  blockPosition: number;
  blocksToExitBlock: number;
}

/**
 * Stream event from the server
 */
export interface StreamEvent {
  /** The execution run ID */
  runId: string | null;
  /** Event type */
  type: StreamEventType;
  /** Durable stream sequence for resumable streams */
  seq?: number;
  /** Timestamp */
  time: number;
  /** Event-specific data */
  data: ProgressData | unknown;
  /** Socket ID (for result and delta events) */
  socket?: string;
  /** HTTP status code */
  statusCode: number;
}

/** A static Entry auth code sent in the X-Entry-Auth-Code header. */
export interface EntryCodeAuthorization {
  kind: "entry_code";
  code: string;
}

/** A bearer token provider. The provider is called before every request attempt. */
export interface BearerAuthorization {
  kind: "bearer";
  getToken: (options: { forceRefresh: boolean }) => Promise<string>;
}

/** Authentication capability used by KitchenClient. */
export type KitchenAuthorization = EntryCodeAuthorization | BearerAuthorization;

/**
 * Configuration for KitchenClient
 */
export interface KitchenClientConfig {
  /** Authentication capability for this client. */
  authorization: KitchenAuthorization;
  /** Entry point environment (default: "entry" for production) */
  entryPoint?: string;
}

/**
 * API key override format
 * Maps service ID to key ID to value
 */
export type OverrideAPIKey = {
  [serviceID: string]: {
    [keyID: string]: string;
  };
};

/** Standardized Kitchen runtime thinking levels. */
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Optional metadata used to relate Kitchen runs to a higher-level agent/session.
 */
export interface AgentRunMetadata {
  agentId?: string;
  agentSessionId?: string;
  agentRunId?: string;
  parentRunId?: string;
  parentToolCallId?: string;
  workspaceId?: string;
  workspaceVersionId?: string;
  idempotencyKey?: string;
}

/**
 * Parameters for sync execution
 */
export interface SyncParams {
  /** The ID of the pipeline/recipe */
  recipeId: string;
  /** The ID of the entry block */
  entryId: string;
  /** Request body data */
  body: unknown;
  /** Enable Kitchen billing (optional) */
  useKitchenBilling?: boolean;
  /** LLM model override (optional) */
  llmOverride?: string;
  /** Standardized runtime thinking level (optional) */
  thinkingOverride?: ThinkingLevel;
  /** API key overrides (optional) */
  apiKeyOverride?: OverrideAPIKey;
  /** Custom headers (optional, for HMAC signatures, etc.) */
  headers?: Record<string, string>;
  /** Optional parent agent/session metadata for durable run tracing */
  agentMetadata?: AgentRunMetadata;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  toolCall: LLMToolCall,
) => unknown | Promise<unknown>;

export type ToolHandlerMap = Record<string, ToolHandler>;

export interface RunWithToolsParams extends SyncParams {
  tools: KitchenTool[];
  handlers: ToolHandlerMap;
  maxToolIterations?: number;
  onToolCall?: (toolCall: LLMToolCall) => void | Promise<void>;
  onToolResult?: (toolResult: LLMToolResult) => void | Promise<void>;
}

/**
 * Parameters for stream execution
 */
export interface StreamParams {
  /** The ID of the pipeline/recipe */
  recipeId: string;
  /** The ID of the entry block */
  entryId: string;
  /** Request body data */
  body: unknown;
  /** Enable Kitchen billing (optional) */
  useKitchenBilling?: boolean;
  /** LLM model override (optional) */
  llmOverride?: string;
  /** Standardized runtime thinking level (optional) */
  thinkingOverride?: ThinkingLevel;
  /** API key overrides (optional) */
  apiKeyOverride?: OverrideAPIKey;
  /** Custom headers (optional, for HMAC signatures, etc.) */
  headers?: Record<string, string>;
  /** Optional parent agent/session metadata for durable run tracing */
  agentMetadata?: AgentRunMetadata;
  /** Abort the active stream request and any resumable recovery requests. */
  signal?: AbortSignal;
}

export interface PipelineRunFinalPayloadRef {
  bucket: string;
  key: string;
  url?: string;
  contentType?: string;
  bytes?: number;
  writtenAt?: number;
}

export interface PipelineRunStatus {
  runId: string;
  pipelineId?: string;
  entryId?: string;
  status: string;
  currentBlock?: string | null;
  blocks?: unknown[];
  startTime?: number;
  endTime?: number | null;
  billableTime?: number | null;
  error?: unknown;
  stream?: {
    enabled?: boolean;
    eventsAvailable?: boolean;
    finalSeq?: number | null;
    eventsDeletedAt?: number | null;
  } | null;
  finalPayloadRef?: PipelineRunFinalPayloadRef | null;
}

export interface PipelineRunEventsResponse {
  runId: string;
  events: StreamEvent[];
  status: string;
  finalPayloadRef?: PipelineRunFinalPayloadRef | null;
  eventsAvailable?: boolean;
}

export interface ResumableStreamParams extends StreamParams {
  runId?: string;
  afterSeq?: number;
  onRunId?: (runId: string) => void;
  onSeq?: (seq: number, event: StreamEvent) => void;
  maxReconnects?: number;
  reconnectDelayMs?: number;
}

/**
 * HTTP response with metadata
 */
export interface HttpResponse {
  data: unknown;
  status: number;
  statusText: string;
}

/**
 * Delta operation for streaming text updates
 * Format: ["i", position, string] or ["d", position] or ["d", position, length]
 */
export type DeltaOperation =
  | ["i", number, string]
  | ["d", number]
  | ["d", number, number];
