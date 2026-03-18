import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools';

export const createMcpServer = (): McpServer => {
    const server = new McpServer({
        name: 'lgm',
        version: '1.0.0',
    });

    registerTools(server);

    return server;
};
