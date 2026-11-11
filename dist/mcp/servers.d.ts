import { type McpClient, type McpClientOptions, type McpRequestOptions } from "./client";
import type { McpResourceContents, McpServerInfo } from "./types";
/** `name` is what notices call the server, by default its id */
export type McpServerConfig = (McpClient | McpClientOptions) & {
    name?: string;
};
export interface McpServerState {
    name: string;
    info: McpServerInfo | null;
    error: string;
}
export interface McpServerFailure {
    id: string;
    name: string;
    /** the raw error, for a tooltip */
    error: string;
}
export interface McpServers {
    readonly clients: Readonly<Record<string, McpClient>>;
    readonly names: Readonly<Record<string, string>>;
    readResource(uri: string, options?: McpRequestOptions): Promise<McpResourceContents[]>;
}
export declare function createMcpServers(config: Readonly<Record<string, McpServerConfig>> | undefined, tabHeaders?: () => Record<string, string>): McpServers;
export declare function failedServers(servers: Readonly<Record<string, McpServerState>>): McpServerFailure[];
/** identifies a set of failures, so a closed notice stays closed until they change */
export declare function failuresKey(failures: readonly McpServerFailure[]): string;
