// @vitest-environment node
// node's Blob survives fake-indexeddb's structured clone, happy-dom's does not
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createAttachmentStore } from "./attachment-store";
import { AttachmentError, attachmentContent, inspectAttachment, MAX_ATTACHMENT_BYTES, rasterSize, renderNotebook } from "./attachments";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

describe("attachments", () => {
  it("classifies text files and refuses binary ones", async () => {
    expect(await inspectAttachment(new File(["badger notes\n"], "notes.md", { type: "text/markdown" }))).toMatchObject({ kind: "text", mimeType: "text/markdown" });
    const err = await inspectAttachment(new File([new Uint8Array([0, 1, 2, 3, 255])], "otter.bin")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentError);
    expect(err).toMatchObject({ code: "unsupported" });
  });

  it("refuses files over the limit and images over 64 megapixels", async () => {
    const big = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "huge.txt");
    await expect(inspectAttachment(big)).rejects.toMatchObject({ code: "tooLarge" });
    expect(rasterSize(png(800, 600), "image/png")).toEqual({ width: 800, height: 600 });
    expect(() => rasterSize(png(10000, 10000), "image/png")).toThrow(/64 megapixels/);
  });

  it("reads PDFs only when PDF support is configured", async () => {
    const pdf = new File(["%PDF-1.7 otter"], "dens.pdf", { type: "application/pdf" });
    await expect(inspectAttachment(pdf)).rejects.toMatchObject({ code: "pdfUnavailable" });
  });

  it("renders notebooks compactly", () => {
    const text = renderNotebook("dig.ipynb", {
      metadata: { kernelspec: { language: "python" } },
      cells: [
        { cell_type: "markdown", source: ["# Dig plan"] },
        { cell_type: "code", source: "print('badger')", outputs: [{ output_type: "stream", text: ["badger\n"] }] },
      ],
    });
    expect(text).toContain("Notebook dig.ipynb: 2 cells (python)");
    expect(text).toContain("```python\nprint('badger')\n```");
    expect(text).toContain("Output:\nbadger");
  });

  it("stores attachments per conversation in IndexedDB", async () => {
    const store = createAttachmentStore("test:attachments");
    const blob = new Blob(["otter diary"], { type: "text/plain" });
    await store.put({ id: "a", conversationId: "c1", name: "diary.txt", mimeType: "text/plain", size: blob.size, kind: "text", blob });
    await store.put({ id: "b", conversationId: "c2", name: "other.txt", mimeType: "text/plain", size: blob.size, kind: "text", blob });
    const record = await store.get("c1", "a");
    expect(record?.name).toBe("diary.txt");
    expect(await attachmentContent(record!, "attachment://a")).toMatchObject({ text: "otter diary", name: "diary.txt" });
    expect(await store.get("c2", "a")).toBeNull();
    await store.removeConversation("c1");
    expect(await store.get("c1", "a")).toBeNull();
    expect(await store.get("c2", "b")).not.toBeNull();
  });
});
