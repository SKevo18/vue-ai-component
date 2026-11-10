import { type McpClient, type McpClientOptions, type McpRequestOptions } from "./client";
import type { McpResourceContents, McpServerInfo } from "./types";
export type McpServerConfig = McpClient | McpClientOptions;
export interface McpServerState {
    info: McpServerInfo | null;
    error: string;
}
export interface McpServers {
    readonly clients: Readonly<Record<string, McpClient>>;
    readResource(uri: string, options?: McpRequestOptions): Promise<McpResourceContents[]>;
}
export declare function createMcpServers(config: Readonly<Record<string, McpServerConfig>> | undefined, tabHeaders?: () => Record<string, string>): McpServers;
export declare function serverErrors(servers: Readonly<Record<string, McpServerState>>): string;
