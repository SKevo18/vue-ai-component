import type { McpClient } from "../mcp/client";
import type { ImageRef } from "./entries";
import type { ImageContent } from "./types";
export declare const READ_LIMIT = 40000;
export interface NamespaceContent {
    name?: string;
    mimeType?: string;
    text?: string;
    image?: ImageRef;
    page?: number;
    pages?: number;
}
export interface LocalNamespace {
    scheme: string;
    template: string;
    description: string;
    read(uri: string, options: {
        page: number;
        signal?: AbortSignal;
    }): Promise<NamespaceContent>;
    image?(ref: ImageRef): Promise<ImageContent>;
}
export interface ReadOptions {
    offset?: number;
    limit?: number;
    page?: number;
    signal?: AbortSignal;
}
export interface ReadResult extends NamespaceContent {
    uri: string;
    offset: number;
    nextOffset?: number;
    totalChars?: number;
}
export interface NamespaceRegistry {
    register(namespace: LocalNamespace): () => void;
    local(): LocalNamespace[];
    read(uri: string, options?: ReadOptions): Promise<ReadResult>;
    image(ref: ImageRef): Promise<ImageContent>;
}
export declare function schemeOf(uri: string): string | null;
/** never splits a surrogate pair */
export declare function textChunk(text: string, offset: number, limit: number): {
    text: string;
    offset: number;
    totalChars: number;
    nextOffset?: number;
};
export interface NamespaceRegistryOptions {
    mcp(): McpClient | null;
    prepareImage(image: ImageContent): Promise<ImageContent>;
}
export declare function createNamespaceRegistry(options: NamespaceRegistryOptions): NamespaceRegistry;
