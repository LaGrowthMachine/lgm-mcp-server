import { McpFlowError } from "../callFlow";
import { getApiKey } from "../requestContext";

// Shared helpers used by both `proxy` and `builtin` endpoint handlers. Kept in
// one place so the wire shape returned to MCP clients stays uniform.

export const resolveApiKey = (extra: {
  authInfo?: { token?: string };
}): string => getApiKey() || extra?.authInfo?.token || "";

export const formatTextContent = (
  title: string,
  data: unknown,
): { content: Array<{ type: "text"; text: string }> } => ({
  content: [
    {
      type: "text" as const,
      text: `## ${title}\n\n${JSON.stringify(data, null, 2)}`,
    },
  ],
});

export const handleToolError = (
  error: unknown,
): { content: Array<{ type: "text"; text: string }>; isError: true } => {
  if (error instanceof McpFlowError) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error (${error.statusCode}): ${error.message}`,
        },
      ],
      isError: true,
    };
  }
  const message =
    error instanceof Error ? error.message : "Unknown error occurred";
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
};
