import type { AttachmentStore } from "../core/attachment-store";
import type { ImageRef, ResourceRef } from "../core/entries";
import { type LocalNamespace, type NamespaceRegistry } from "../core/namespaces";
import { type ImageContent } from "../core/types";
import type { Translate } from "../i18n";
import type { AiState, AttachedFile } from "./types";
export interface ChatAttachments {
    namespace: LocalNamespace;
    saveImage(image: ImageContent, name?: string): Promise<ImageRef>;
    attachFiles(files: Iterable<File>): Promise<void>;
    attachText(text: string, name: string): Promise<ResourceRef | null>;
    files(): Promise<AttachedFile[]>;
    imageUrl(ref: ImageRef): Promise<string>;
    previewResource(uri: string): void;
    closePreview(): void;
}
interface Dependencies {
    t: Translate;
    namespaces: NamespaceRegistry;
    attach(ref: ResourceRef): void;
    saveNow(): Promise<void>;
}
export declare function createChatAttachments(state: AiState, store: AttachmentStore, deps: Dependencies): ChatAttachments;
export {};
