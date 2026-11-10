import type { ResourceRef } from "../core/entries";
import type { StoredConversation } from "../stores/conversations";
import type { Catalog } from "./catalog";
import type { AiState } from "./types";
interface ExportInput {
    state: AiState;
    stored: StoredConversation;
    current: boolean;
    catalog: Catalog;
    connection: string | null;
    model: string | null;
    context: ResourceRef[];
}
export declare function conversationExport({ state, stored, current, catalog, connection, model, context }: ExportInput): Promise<{
    filename: string;
    json: string;
}>;
export {};
