import type { AttachmentRecord, AttachmentStore } from "../core/attachment-store";
import { AttachmentError, attachmentContent, attachmentImage, fromBase64, inspectAttachment } from "../core/attachments";
import type { ImageRef, ResourceRef } from "../core/entries";
import { randomId } from "../core/ids";
import { schemeOf, type LocalNamespace, type NamespaceRegistry } from "../core/namespaces";
import { errorText, type ImageContent } from "../core/types";
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

const ICONS: Record<AttachmentRecord["kind"], string> = { image: "image", pdf: "file-text", text: "file" };

export function createChatAttachments(state: AiState, store: AttachmentStore, deps: Dependencies): ChatAttachments {
  let previewRequest = 0;

  async function record(uri: string): Promise<AttachmentRecord> {
    const id = decodeURIComponent(uri.replace(/^attachment:\/\//i, "").replace(/[#?].*$/, ""));
    const found = id ? await store.get(state.conversationId, id) : null;
    if (!found) throw new Error(`${uri} is not an attachment of this chat.`);
    return found;
  }

  const attachedFile = (uri: string, r: AttachmentRecord): AttachedFile => ({ uri, name: r.name, mimeType: r.mimeType, size: r.size, blob: r.blob });

  async function add(file: File): Promise<ResourceRef | null> {
    state.adding.push(file.name);
    try {
      const inspected = await inspectAttachment(file);
      const id = randomId(9);
      await store.put({ ...inspected, id, conversationId: state.conversationId });
      const ref = { uri: `attachment://${id}`, label: file.name, size: inspected.size, icon: ICONS[inspected.kind] };
      deps.attach(ref);
      await deps.saveNow();
      return ref;
    } catch (e) {
      state.attachError = `${file.name}: ${e instanceof AttachmentError ? deps.t(`attachments.${e.code}`) : errorText(e)}`;
      return null;
    } finally {
      state.adding.splice(state.adding.indexOf(file.name), 1);
    }
  }

  function closePreview() {
    previewRequest++;
    state.preview = null;
  }

  return {
    namespace: {
      scheme: "attachment",
      template: "attachment://{id}",
      description: "Files attached to this chat and images tools returned. PDFs have pages (page=2, ...).",
      read: async (uri, { page }) => attachmentContent(await record(uri), uri, page),
      image: async (ref) => attachmentImage(await record(ref.uri), ref.page),
    },
    async saveImage(image, name) {
      const id = randomId(9);
      const blob = fromBase64(image.data, image.mimeType);
      await store.put({ id, conversationId: state.conversationId, name: name ?? `image-${id}.${image.mimeType.split("/")[1] ?? "png"}`, mimeType: image.mimeType, size: blob.size, kind: "image", blob });
      return { uri: `attachment://${id}` };
    },
    async attachFiles(files) {
      state.attachError = "";
      await Promise.all([...files].map(add));
    },
    async attachText(text, name) {
      state.attachError = "";
      return add(new File([text], name, { type: "text/plain" }));
    },
    async files() {
      const uris = new Set<string>();
      for (const e of state.entries) if (e.role === "user") for (const r of e.resources ?? []) uris.add(r.uri);
      for (const r of state.attached) uris.add(r.uri);
      const found = await Promise.all([...uris].filter((u) => schemeOf(u) === "attachment").map((uri) => record(uri).then((r) => attachedFile(uri, r), () => null)));
      return found.filter((f): f is AttachedFile => f !== null);
    },
    async imageUrl(ref) {
      if (schemeOf(ref.uri) === "attachment" && !ref.page) return URL.createObjectURL((await record(ref.uri)).blob);
      const image = await deps.namespaces.image(ref);
      return `data:${image.mimeType};base64,${image.data}`;
    },
    previewResource(uri) {
      const request = ++previewRequest;
      state.preview = { uri };
      if (schemeOf(uri) !== "attachment") return;
      // a missing attachment is reported by the viewer's own read
      void record(uri).then((r) => {
        if (request !== previewRequest || !state.preview) return;
        state.preview.original = attachedFile(uri, r);
      }, () => undefined);
    },
    closePreview,
  };
}
