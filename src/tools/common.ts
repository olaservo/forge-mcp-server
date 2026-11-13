import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/server";
import type { z } from "zod";

export const json = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>,
});

export const failure = (e: unknown): CallToolResult => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return json(await fn());
  } catch (e) {
    return failure(e);
  }
}

export const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const acting = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export interface ToolConfig<In extends z.ZodType> {
  title: string;
  description: string;
  inputSchema: In;
  outputSchema: z.ZodType;
  annotations: ToolAnnotations;
}

export type RegisterTool = <In extends z.ZodType>(
  name: string,
  config: ToolConfig<In>,
  handler: (args: z.output<In>) => Promise<CallToolResult>,
) => void;
