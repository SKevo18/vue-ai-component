import { type McpResource, type McpResourceContents, type McpResourceTemplate, type McpServerInfo, type McpTool, type McpToolResult } from "./types";
export interface McpClientOptions {
    url: string;
    headers?: () => Record<string, string> | Promise<Record<string, string>>;
    fetch?: typeof fetch;
    /** default `include`, so the app's session cookie goes along */
    credentials?: RequestCredentials;
    clientInfo?: {
        name: string;
        version: string;
    };
}
export interface McpRequestOptions {
    signal?: AbortSignal;
}
export interface McpProgress {
    progress: number;
    total?: number;
    message?: string;
}
export interface McpCallOptions extends McpRequestOptions {
    /** progress notifications also keep long calls alive behind idle-timeout proxies */
    onProgress?(progress: McpProgress): void;
}
export interface McpListOptions extends McpRequestOptions {
    refresh?: boolean;
}
export interface McpClient {
    readonly url: string;
    readonly info: McpServerInfo | null;
    connect(options?: McpRequestOptions): Promise<McpServerInfo>;
    listTools(options?: McpListOptions): Promise<McpTool[]>;
    callTool(name: string, args: Record<string, unknown>, options?: McpCallOptions): Promise<McpToolResult>;
    listResources(options?: McpListOptions): Promise<McpResource[]>;
    listResourceTemplates(options?: McpListOptions): Promise<McpResourceTemplate[]>;
    readResource(uri: string, options?: McpRequestOptions): Promise<McpResourceContents[]>;
    request<T>(method: string, params?: Record<string, unknown>, options?: McpRequestOptions): Promise<T>;
    reset(): void;
}
export declare function createMcpClient(options: McpClientOptions): McpClient;
