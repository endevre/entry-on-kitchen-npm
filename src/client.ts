import type {
  KitchenClientConfig,
  KitchenResponse,
  SyncParams,
  StreamParams,
  StreamEvent,
  HttpResponse,
  DeltaOperation,
  OverrideAPIKey,
} from "./types";

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
