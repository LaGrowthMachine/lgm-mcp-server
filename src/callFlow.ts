import { getApiUrl } from './requestContext';

const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 2;

export class McpFlowError extends Error {
    public statusCode: number;
    public retryAfter?: number;

    constructor(message: string, statusCode: number, retryAfter?: number) {
        super(message);
        this.name = 'McpFlowError';
        this.statusCode = statusCode;
        this.retryAfter = retryAfter;
    }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const callFlow = async (
    apiKey: string,
    path: string,
    params?: Record<string, unknown>,
    options?: { method?: string; retries?: number }
): Promise<unknown> => {
    const method = options?.method || 'GET';
    const retries = options?.retries ?? MAX_RETRIES;

    const apiUrl = getApiUrl();
    const url = new URL(`/flow${path}`, apiUrl);

    // Debug logs
    console.error(`[MCP DEBUG] API URL: ${apiUrl}`);
    console.error(`[MCP DEBUG] Full URL: ${url.toString()}`);
    console.error(`[MCP DEBUG] API Key present: ${!!apiKey}`);
    console.error(`[MCP DEBUG] API Key length: ${apiKey.length}`);
    console.error(`[MCP DEBUG] API Key (first 8 chars): ${apiKey.substring(0, 8)}...`);
    console.error(`[MCP DEBUG] Method: ${method}`);
    console.error(`[MCP DEBUG] process.env.LGM_API_KEY present: ${!!process.env.LGM_API_KEY}`);

    const fetchOptions: RequestInit = {
        method,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    };

    if (method === 'GET' && params) {
        Object.entries(params).forEach(([key, value]) => {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, String(value));
            }
        });
    } else if (method !== 'GET' && params) {
        fetchOptions.body = JSON.stringify(params);
    }

    const response = await fetch(url.toString(), fetchOptions);

    console.error(`[MCP DEBUG] Response status: ${response.status}`);
    console.error(`[MCP DEBUG] Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);

    if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
        throw new McpFlowError('Rate limit exceeded. Try again later.', 429, retryAfter);
    }

    if (response.status === 401) {
        throw new McpFlowError('Authentication failed. Check your API key.', 401);
    }

    if (response.status === 403) {
        throw new McpFlowError('Permission denied. Your plan may not include this feature.', 403);
    }

    if (response.status === 404) {
        throw new McpFlowError('Resource not found.', 404);
    }

    if (response.status === 400) {
        const body = await response.json().catch(() => ({ error: 'Bad request' }));
        const message = (body as Record<string, unknown>).error || 'Bad request';
        throw new McpFlowError(String(message), 400);
    }

    if (response.status >= 500 && retries > 0) {
        const backoffMs = 1000 * (MAX_RETRIES - retries + 1);
        await sleep(backoffMs);
        return callFlow(apiKey, path, params, { method, retries: retries - 1 });
    }

    if (response.status >= 500) {
        throw new McpFlowError('LGM API unavailable. Please try again later.', response.status);
    }

    return response.json();
};
