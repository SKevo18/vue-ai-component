import type { Entry, ResourceRef } from "../core/entries";
export interface ConversationMeta {
    id: string;
    title: string;
    /** ms epoch */
    updatedAt: number;
}
export interface StoredConversation extends ConversationMeta {
    entries: Entry[];
    connection?: string;
    model?: string;
    attached?: ResourceRef[];
    draft?: string;
    allowedTools?: string[];
    autoApprove?: boolean;
}
export interface ConversationStore {
    list(): Promise<ConversationMeta[]>;
    load(id: string): Promise<StoredConversation | null>;
    save(conversation: StoredConversation): Promise<void>;
    remove(id: string): Promise<void>;
}
export interface LocalConversationStoreOptions {
    prefix?: string;
    /** conversations kept; older ones are dropped, default 50 */
    max?: number;
    storage?: Storage;
}
/** the index lives under `<prefix>conversations`, the bodies under `<prefix>conversation:<id>` */
export declare function createLocalConversationStore(options?: LocalConversationStoreOptions): ConversationStore;
