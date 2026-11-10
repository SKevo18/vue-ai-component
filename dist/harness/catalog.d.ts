import { type ComputedRef } from "vue";
import type { ResourceRef } from "../core/entries";
import type { NamespaceRegistry } from "../core/namespaces";
import type { HarnessTool } from "../core/tools";
import type { Locale } from "../i18n";
import type { McpClient } from "../mcp/client";
import type { AiOptions, AiState, PickerItem } from "./types";
export interface Catalog {
    tools(refresh?: boolean): Promise<HarnessTool[]>;
    forgetTools(): void;
    systemPrompt(): Promise<string>;
    pickerItems(query: string, signal: AbortSignal): Promise<PickerItem[]>;
}
interface Dependencies {
    mcp: McpClient | null;
    namespaces: NamespaceRegistry;
    locale(): Locale;
    contextItems: ComputedRef<ResourceRef[]>;
}
export declare function createCatalog(state: AiState, options: AiOptions, { mcp, namespaces, locale, contextItems }: Dependencies): Catalog;
export {};
