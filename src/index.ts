/**
 * Entry on Kitchen - Official JavaScript/TypeScript Library
 *
 * A simple library for executing recipes on the Entry on Kitchen API.
 * Supports both synchronous execution and real-time HTTP streaming.
 *
 * @packageDocumentation
 */

export { KitchenClient, applyDelta } from "./client";
export type {
  KitchenClientConfig,
  KitchenResponse,
  SyncParams,
  StreamParams,
  StreamEvent,
  StreamEventType,
  ProgressData,
  HttpResponse,
  DeltaOperation,
} from "./types";
