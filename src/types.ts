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
export type StreamEventType = "progress" | "result" | "delta" | "info" | "end";

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
  runId: string;
  /** Event type */
  type: StreamEventType;
  /** Timestamp */
  time: number;
  /** Event-specific data */
  data: ProgressData | unknown;
  /** Socket ID (for result and delta events) */
  socket?: string;
  /** HTTP status code */
  statusCode: number;
}

/**
 * Configuration for KitchenClient
 */
export interface KitchenClientConfig {
  /** Your X-Entry-Auth-Code for authentication */
  authCode: string;
  /** Entry point environment (default: "entry" for production) */
  entryPoint?: string;
  /** Use Authorization header instead of X-Entry-Auth-Code (optional) */
  useAuthorizationHeader?: boolean;
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
  /** API key overrides (optional) */
  apiKeyOverride?: OverrideAPIKey;
  /** Custom headers (optional, for HMAC signatures, etc.) */
  headers?: Record<string, string>;
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
  /** API key overrides (optional) */
  apiKeyOverride?: OverrideAPIKey;
  /** Custom headers (optional, for HMAC signatures, etc.) */
  headers?: Record<string, string>;
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
