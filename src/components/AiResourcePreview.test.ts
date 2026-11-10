import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { componentAi } from "../../test/component-ai";
import type { Ai } from "../ai";
import type { ReadOptions, ReadResult } from "../core/namespaces";
import AiResourcePreview from "./AiResourcePreview.vue";

const mounted: VueWrapper[] = [];
const revoke = vi.fn();
let serial = 0;

beforeEach(() => {
  serial = 0;
  revoke.mockClear();
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn(() => `blob:preview-${++serial}`);
    static revokeObjectURL = revoke;
  });
  vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) { this.open = true; });
  vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) { this.open = false; });
});

afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function show(ai: Ai, uri = "note://den") {
  const w = mount(AiResourcePreview, { props: { ai }, attachTo: document.body });
  mounted.push(w);
  ai.previewResource(uri);
  await flushPromises();
  return w;
}

function result(uri: string, text: string): ReadResult {
  return { uri, offset: 0, text, totalChars: text.length };
}

describe("AiResourcePreview", () => {
  it("pages text chunks forwards and backwards, rendering HTML as plain text", async () => {
    const text = "<img src=x onerror=alert(1)>" + "x".repeat(40000);
    const ai = componentAi({ namespaces: [{ scheme: "note", template: "note://{id}", description: "Notes", read: async () => ({ name: "Den", text }) }] });
    const read = vi.spyOn(ai, "read");
    const w = await show(ai);
    expect(w.find("dialog").attributes("open")).toBeDefined();
    expect(w.find("pre").text()).toBe(text.slice(0, 40000));
    expect(w.find("img").exists()).toBe(false);
    expect(w.find("script").exists()).toBe(false);
    await w.findAll("nav button")[1]!.trigger("click");
    await flushPromises();
    expect(w.find("pre").text()).toBe(text.slice(40000));
    expect(read.mock.calls.at(-1)?.[1]?.offset).toBe(40000);
    await w.findAll("nav button")[0]!.trigger("click");
    await flushPromises();
    expect(w.find("pre").text()).toBe(text.slice(0, 40000));
  });

  it("uses namespace image/page reads and original attachment downloads, cleaning every object URL", async () => {
    const ai = componentAi();
    const read = vi.spyOn(ai, "read").mockImplementation(async (uri, opts) => ({ uri, name: "Dens.pdf", offset: 0, page: opts?.page ?? 1, pages: 2, image: { uri, page: opts?.page ?? 1 } }));
    const imageUrl = vi.spyOn(ai, "imageUrl").mockResolvedValueOnce("blob:page-1").mockResolvedValueOnce("blob:page-2");
    const w = await show(ai, "attachment://pdf");
    ai.state.preview!.original = { uri: "attachment://pdf", name: "Dens.pdf", mimeType: "application/pdf", size: 8, blob: new Blob(["original"]) };
    await flushPromises();
    expect(w.find("img").attributes("src")).toBe("blob:page-1");
    expect(w.find("a[download]").attributes()).toMatchObject({ download: "Dens.pdf", href: "blob:preview-1" });
    await w.find("button[aria-label='Next page']").trigger("click");
    await flushPromises();
    expect(read.mock.calls.at(-1)?.[1]?.page).toBe(2);
    expect(imageUrl).toHaveBeenLastCalledWith({ uri: "attachment://pdf", page: 2 });
    expect(w.find("img").attributes("src")).toBe("blob:page-2");
    expect(revoke).toHaveBeenCalledWith("blob:page-1");
    await w.find("button[aria-label='Close']").trigger("click");
    expect(ai.state.preview).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:page-2");
    expect(revoke).toHaveBeenCalledWith("blob:preview-1");
  });

  it("aborts obsolete reads and ignores late results after replacement or Escape", async () => {
    const ai = componentAi();
    const pending = Promise.withResolvers<ReadResult>();
    let oldSignal: AbortSignal | undefined;
    vi.spyOn(ai, "read").mockImplementation((uri, opts?: ReadOptions) => {
      if (uri === "note://old") {
        oldSignal = opts?.signal;
        return pending.promise;
      }
      return Promise.resolve(result(uri, "Current"));
    });
    const w = await show(ai, "note://old");
    ai.previewResource("note://new");
    await flushPromises();
    expect(oldSignal?.aborted).toBe(true);
    pending.resolve(result("note://old", "Obsolete"));
    await flushPromises();
    expect(w.find("pre").text()).toBe("Current");
    await w.find("dialog").trigger("cancel"); // native dialog emits cancel for Escape
    expect(ai.state.preview).toBeNull();
    expect(w.find("dialog").exists()).toBe(false);
  });

  it("revokes images that finish after close and on unmount", async () => {
    const ai = componentAi();
    vi.spyOn(ai, "read").mockResolvedValue({ uri: "note://image", offset: 0, image: { uri: "note://image" } });
    const pending = Promise.withResolvers<string>();
    vi.spyOn(ai, "imageUrl").mockReturnValue(pending.promise);
    await show(ai, "note://image");
    ai.closePreview();
    await flushPromises();
    pending.resolve("blob:late-image");
    await flushPromises();
    expect(revoke).toHaveBeenCalledWith("blob:late-image");
    expect(ai.state.preview).toBeNull();
  });

  it("revokes the current image on unmount and closes the preview", async () => {
    const ai = componentAi();
    vi.spyOn(ai, "read").mockResolvedValue({ uri: "note://image", offset: 0, image: { uri: "note://image" } });
    vi.spyOn(ai, "imageUrl").mockResolvedValue("blob:unmounted-image");
    const w = await show(ai, "note://image");
    mounted.splice(mounted.indexOf(w), 1);
    w.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:unmounted-image");
    expect(ai.state.preview).toBeNull();
  });

  it("rejects unsafe image schemes and shows read failures without unsafe markup", async () => {
    const ai = componentAi();
    vi.spyOn(ai, "read").mockResolvedValueOnce({ uri: "note://image", offset: 0, image: { uri: "note://image" } }).mockRejectedValueOnce(new Error("<script>broken</script>"));
    vi.spyOn(ai, "imageUrl").mockResolvedValue("javascript:alert(1)");
    const w = await show(ai, "note://image");
    expect(w.find("img").exists()).toBe(false);
    expect(w.find("[role=alert]").text()).toContain("could not be displayed");
    ai.previewResource("note://broken");
    await flushPromises();
    expect(w.find("[role=alert]").text()).toContain("<script>broken</script>");
    expect(w.find("script").exists()).toBe(false);
  });
});
