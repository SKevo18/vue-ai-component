import type { McpContent } from "../mcp/types";
export interface BrowserCall {
    id: string;
    op: string;
    arguments?: Record<string, unknown>;
}
export interface BrowserCallResult {
    content: McpContent[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
}
/**
 * returns a string (text), a full result, or any JSON value (sent as JSON text); throws for errors. `signal` aborts
 * when the call times out.
 */
export type BrowserHandler = (args: Record<string, unknown>, call: BrowserCall, signal: AbortSignal) => unknown;
export interface BrowserToolHostOptions {
    respond(callId: string, result: BrowserCallResult): unknown;
    reportFocus?(state: {
        tab: string;
        focused: boolean;
    }): unknown;
    /** ms before a handler counts as failed, default 30000 */
    timeoutMs?: number;
    tabId?: string;
}
export interface BrowserToolHost {
    readonly tabId: string;
    register(op: string, handler: BrowserHandler, options?: {
        timeoutMs?: number;
    }): () => void;
    handle(call: unknown): Promise<void>;
    headers(): Record<string, string>;
    dispose(): void;
}
export declare function createBrowserToolHost(options: BrowserToolHostOptions): BrowserToolHost;
