import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type JsonObject = Record<string, unknown>;

/**
 * Wraps tool data as an MCP result. Data with `ok: false` is flagged with `isError`
 * so clients treat refused game actions and invalid arguments as failures.
 */
export function toolResult(data: JsonObject): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    ...(data.ok === false ? { isError: true } : {}),
  };
}
