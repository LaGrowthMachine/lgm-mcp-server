import { callFlow } from './callFlow';

export const trackMcpEvent = async (
    apiKey: string,
    eventName: string,
    properties?: Record<string, string>
): Promise<void> => {
    try {
        await callFlow(apiKey, '/tracking/mcp', { eventName, properties }, { method: 'POST' });
    } catch {
        // Tracking errors should not break tool execution
    }
};
