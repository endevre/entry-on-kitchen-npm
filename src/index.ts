/**
 * Entry on Kitchen - Official JavaScript/TypeScript Library
 *
 * A simple library for executing recipes on the Entry on Kitchen API.
 * Supports both synchronous execution and real-time HTTP streaming.
 *
 * @packageDocumentation
 */

export { KitchenAuthorizationError, KitchenClient, applyDelta } from "./client";
export {
  createExternalTool,
  createKitchenEntryTool,
  createToolError,
  createToolResult,
  getContinuation,
  getToolCallRequest,
  getToolCalls,
  isToolCallRequest,
  withToolResults,
  withTools,
} from "./tools";
export type {
  JSONSchema,
  BearerAuthorization,
  EntryCodeAuthorization,
  KitchenAuthorization,
  KitchenClientConfig,
  KitchenEntryTool,
  KitchenExternalTool,
  KitchenResponse,
  KitchenTool,
  LLMContinuation,
  LLMToolCall,
  LLMToolResult,
  SyncParams,
  StreamParams,
  ResumableStreamParams,
  ThinkingLevel,
  StreamEvent,
  StreamEventType,
  PipelineRunEventsResponse,
  PipelineRunFinalPayloadRef,
  PipelineRunStatus,
  ToolCallRequest,
  ToolHandler,
  ToolHandlerMap,
  RunWithToolsParams,
  ProgressData,
  HttpResponse,
  DeltaOperation,
} from "./types";
