import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
    apiUrl?: string;
    apiKey?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

const ALLOWED_API_URL_PATTERNS = [
    /^https:\/\/([a-z0-9-]+\.)*lagrowthmachine\.com$/,
    /^http:\/\/localhost(:\d+)?$/,
    /^http:\/\/127\.0\.0\.1(:\d+)?$/,
];

export const isAllowedApiUrl = (url: string): boolean => {
    return ALLOWED_API_URL_PATTERNS.some(pattern => pattern.test(url));
};

export const getApiUrl = (): string => {
    const context = requestContext.getStore();
    return context?.apiUrl || process.env.LGM_API_URL || 'https://api.lagrowthmachine.com';
};

export const getApiKey = (): string => {
    const context = requestContext.getStore();
    return context?.apiKey || process.env.LGM_API_KEY || '';
};
