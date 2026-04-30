import type {
  JSONSchema,
  KitchenEntryTool,
  KitchenExternalTool,
  KitchenResponse,
  KitchenTool,
  LLMContinuation,
  LLMToolCall,
  LLMToolResult,
  ToolCallRequest,
} from "./types";

function sanitizeToolName(name: string): string {
  let cleaned = String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!cleaned) {
    cleaned = "tool";
  }
  if (!/^[a-zA-Z_]/.test(cleaned)) {
    cleaned = `tool_${cleaned}`;
  }
  return cleaned.slice(0, 64);
}

function normalizeInputSchema(inputSchema?: JSONSchema): JSONSchema {
  const schema = { ...(inputSchema || {}) };
  if (!schema.type) {
    schema.type = "object";
  }
  if (String(schema.type).toLowerCase() === "object" && !schema.properties) {
    schema.properties = {};
  }
  return schema;
}

function bodyToObject(body: unknown): Record<string, unknown> {
  if (typeof body === "string") {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { input: parsed };
  }
  return body && typeof body === "object" && !Array.isArray(body)
    ? { ...(body as Record<string, unknown>) }
    : { input: body };
}

export function createExternalTool(params: {
  name: string;
  description: string;
  inputSchema?: JSONSchema;
}): KitchenExternalTool {
  return {
    type: "KitchenTool",
    version: 1,
    name: sanitizeToolName(params.name),
    description: params.description || "",
    input_schema: normalizeInputSchema(params.inputSchema),
    executor: { type: "external" },
  };
}

export function createKitchenEntryTool(params: {
  name: string;
  description: string;
  pipelineId: string;
  entryBlockId: string;
  inputSchema?: JSONSchema;
  outputMode?: "full_exit" | "selected_output" | "text";
  selectedOutput?: string;
}): KitchenEntryTool {
  return {
    type: "KitchenTool",
    version: 1,
    name: sanitizeToolName(params.name),
    description: params.description || "",
    input_schema: normalizeInputSchema(params.inputSchema),
    executor: {
      type: "entry",
      pipelineId: params.pipelineId,
      entryBlockId: params.entryBlockId,
      output_mode: params.outputMode || "full_exit",
      ...(params.selectedOutput ? { selected_output: params.selectedOutput } : {}),
    },
  };
}

export function createToolResult(params: {
  toolCallId: string;
  name: string;
  output: unknown;
}): LLMToolResult {
  return {
    type: "LLMToolResult",
    version: 1,
    tool_call_id: params.toolCallId,
    name: sanitizeToolName(params.name),
    status: "success",
    output: params.output,
  };
}

export function createToolError(params: {
  toolCallId: string;
  name: string;
  message: string;
  code?: string;
  details?: unknown;
}): LLMToolResult {
  return {
    type: "LLMToolResult",
    version: 1,
    tool_call_id: params.toolCallId,
    name: sanitizeToolName(params.name),
    status: "error",
    error: {
      message: params.message,
      ...(params.code ? { code: params.code } : {}),
      ...(params.details !== undefined ? { details: params.details } : {}),
    },
  };
}

export function withTools<TBody>(body: TBody, tools: KitchenTool[]): Record<string, unknown> {
  return {
    ...bodyToObject(body),
    tools,
  };
}

export function withToolResults<TBody>(
  body: TBody,
  toolResults: LLMToolResult[],
  continuation: LLMContinuation,
): Record<string, unknown> {
  return {
    ...bodyToObject(body),
    tool_results: toolResults,
    continuation,
  };
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  if (!value.trim()) {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function getToolCallRequest(value: unknown): ToolCallRequest | null {
  const parsed = parseMaybeJson(value) as unknown;
  const response = parsed as Partial<KitchenResponse> & Record<string, unknown>;
  const candidate = parseMaybeJson(response?.result ?? parsed) as Partial<ToolCallRequest> | null;
  if (
    candidate &&
    typeof candidate === "object" &&
    candidate.status === "requires_tool_outputs" &&
    Array.isArray(candidate.tool_calls) &&
    candidate.continuation
  ) {
    return candidate as ToolCallRequest;
  }
  return null;
}

export function isToolCallRequest(value: unknown): boolean {
  return getToolCallRequest(value) !== null;
}

export function getToolCalls(value: unknown): LLMToolCall[] {
  return getToolCallRequest(value)?.tool_calls || [];
}

export function getContinuation(value: unknown): LLMContinuation | null {
  return getToolCallRequest(value)?.continuation || null;
}
