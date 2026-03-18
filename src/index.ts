import { createMcpServer } from './server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

const LGM_API_URL = process.env.LGM_API_URL || 'https://api.lagrowthmachine.com';
const PORT = parseInt(process.env.PORT || '3001', 10);
const TRANSPORT = process.env.LGM_MCP_TRANSPORT || 'http';

const startHttpServer = async () => {
    const app = express();
    app.use(express.json());

    // Health check endpoints
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', version: '1.0.0' });
    });

    app.get('/health/ready', async (_req, res) => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            await fetch(`${LGM_API_URL}/flow/members`, {
                method: 'HEAD',
                signal: controller.signal,
            }).catch(() => {
                // Ignore fetch errors for readiness
            });
            clearTimeout(timeout);
            res.json({ status: 'ready' });
        } catch {
            res.status(503).json({ status: 'not ready' });
        }
    });

    // MCP transport
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    app.post('/mcp', async (req, res) => {
        await transport.handleRequest(req, res);
    });

    app.get('/mcp', async (req, res) => {
        await transport.handleRequest(req, res);
    });

    app.delete('/mcp', async (req, res) => {
        await transport.handleRequest(req, res);
    });

    await server.connect(transport);

    const httpServer = app.listen(PORT, () => {
        console.log(`LGM MCP Server running on port ${PORT}`);
        console.log(`Health: http://localhost:${PORT}/health`);
        console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
    });

    // Graceful shutdown
    const shutdown = () => {
        console.log('Received shutdown signal, draining connections...');
        httpServer.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
        setTimeout(() => {
            console.log('Force shutdown after timeout');
            process.exit(1);
        }, 5000);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
};

const startStdioServer = async () => {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
};

if (TRANSPORT === 'stdio') {
    startStdioServer().catch(error => {
        console.error('Failed to start stdio server:', error);
        process.exit(1);
    });
} else {
    startHttpServer().catch(error => {
        console.error('Failed to start HTTP server:', error);
        process.exit(1);
    });
}
