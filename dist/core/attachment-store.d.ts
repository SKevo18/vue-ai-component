export interface AttachmentRecord {
    id: string;
    conversationId: string;
    name: string;
    mimeType: string;
    size: number;
    kind: "text" | "image" | "pdf";
    blob: Blob;
}
export interface AttachmentStore {
    put(record: AttachmentRecord): Promise<void>;
    get(conversationId: string, id: string): Promise<AttachmentRecord | null>;
    removeConversation(conversationId: string): Promise<void>;
    clear(): Promise<void>;
}
export declare function createAttachmentStore(name: string): AttachmentStore;
