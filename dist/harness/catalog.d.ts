import { type ComputedRef } from "vue";
import type { ResourceRef } from "../core/entries";
import type { NamespaceRegistry } from "../core/namespaces";
import type { HarnessTool } from "../core/tools";
import type { Locale } from "../i18n";
import type { McpServers } from "../mcp/servers";
import type { AiOptions, AiState, PickerItem } from "./types";
export interface Catalog {
    tools(refresh?: boolean): Promise<HarnessTool[]>;
    forgetTools(): void;
    systemPrompt(): Promise<string>;
    pickerItems(query: string, signal: AbortSignal): Promise<PickerItem[]>;
}
interface Dependencies {
    servers: McpServers;
    namespaces: NamespaceRegistry;
    locale(): Locale;
    contextItems: ComputedRef<ResourceRef[]>;
}
export declare function createCatalog(state: AiState, options: AiOptions, { servers, namespaces, locale, contextItems }: Dependencies): Catalog;
export {};
