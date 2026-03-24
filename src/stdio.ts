import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";

const main = async () => {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((error) => {
  console.error("[LGM] Fatal error:", error);
  process.exit(1);
});
