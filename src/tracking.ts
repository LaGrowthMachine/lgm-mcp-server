import { callFlow } from './callFlow';

export const trackMcpEvent = async (
    apiKey: string,
    eventName: string,
    properties?: Record<string, string>
): Promise<void> => {
    try {
        await callFlow(apiKey, '/tracking/mcp', { eventName, properties }, { method: 'POST' });
    } catch (error) {
        console.error("Tracking event failed:", error);
    }
};
