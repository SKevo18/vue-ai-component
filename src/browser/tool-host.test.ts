import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserToolHost, type BrowserCallResult } from "./tool-host";

function host(options: { timeoutMs?: number; reportFocus?: (s: { tab: string; focused: boolean }) => void } = {}) {
  const responses: { id: string; result: BrowserCallResult }[] = [];
  const h = createBrowserToolHost({ respond: (id, result) => void responses.push({ id, result }), ...options });
  return { h, responses };
}

afterEach(() => vi.useRealTimers());

describe("browser tool host", () => {
  it("runs the handler and responds with an MCP result", async () => {
    const { h, responses } = host();
    h.register("editor.get_markdown", (args) => `# Burrow ${args.id}`);
    h.register("ui.open", (args) => ({ opened: args.path }));
    await h.handle({ type: "browser_call", id: "k1", op: "editor.get_markdown", arguments: { id: 4 } });
    await h.handle({ id: "k2", op: "ui.open", arguments: { path: "/dens" } });
    expect(responses).toEqual([
      { id: "k1", result: { content: [{ type: "text", text: "# Burrow 4" }] } },
      { id: "k2", result: { content: [{ type: "text", text: '{"opened":"/dens"}' }] } },
    ]);
  });

  it("keeps structured content on success and error results", async () => {
    const { h, responses } = host();
    h.register("editor.get_markdown", () => ({ content: [{ type: "text", text: "# Den" }], structuredContent: { markdown: "# Den", tag: "a1b2" } }));
    h.register("editor.set_markdown", () => ({ content: [{ type: "text", text: "Stale tag." }], structuredContent: { conflict: true }, isError: true }));
    await h.handle({ id: "g", op: "editor.get_markdown" });
    await h.handle({ id: "s", op: "editor.set_markdown" });
    expect(responses[0]!.result).toEqual({ content: [{ type: "text", text: "# Den" }], structuredContent: { markdown: "# Den", tag: "a1b2" } });
    expect(responses[1]!.result).toEqual({ content: [{ type: "text", text: "Stale tag." }], structuredContent: { conflict: true }, isError: true });
  });

  it("passes full results through and reports thrown errors as tool errors", async () => {
    const { h, responses } = host();
    h.register("photo", () => ({ content: [{ type: "image", mimeType: "image/png", data: "AAA" }] }));
    h.register("explode", () => {
      throw new Error("the otter dam broke");
    });
    await h.handle({ id: "p", op: "photo" });
    await h.handle({ id: "x", op: "explode" });
    expect(responses[0]!.result).toEqual({ content: [{ type: "image", mimeType: "image/png", data: "AAA" }] });
    expect(responses[1]!.result).toEqual({ content: [{ type: "text", text: "the otter dam broke" }], isError: true });
  });

  it("answers unknown ops with an error and ignores malformed or repeated calls", async () => {
    const { h, responses } = host();
    const run = vi.fn(() => "ok");
    h.register("known", run);
    await h.handle({ id: "u", op: "summon_heron" });
    await h.handle({ op: "known" });
    await h.handle("browser_call");
    await h.handle({ id: "d", op: "known" });
    await h.handle({ id: "d", op: "known" });
    expect(responses.map((r) => r.id)).toEqual(["u", "d"]);
    expect(responses[0]!.result.isError).toBe(true);
    expect(responses[0]!.result.content[0]).toMatchObject({ text: expect.stringContaining("summon_heron") });
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports a handler that runs too long as an error", async () => {
    vi.useFakeTimers();
    const { h, responses } = host({ timeoutMs: 5000 });
    h.register("slow_dig", () => new Promise(() => undefined));
    h.register("quick_dig", () => new Promise((r) => setTimeout(() => r("dug"), 1000)), { timeoutMs: 500 });
    const slow = h.handle({ id: "s", op: "slow_dig" });
    const quick = h.handle({ id: "q", op: "quick_dig" });
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([slow, quick]);
    expect(responses.find((r) => r.id === "s")!.result).toEqual({ content: [{ type: "text", text: "slow_dig did not finish within 5 s." }], isError: true });
    expect(responses.find((r) => r.id === "q")!.result.isError).toBe(true);
  });

  it("aborts the handler's signal when the call times out", async () => {
    vi.useFakeTimers();
    const { h } = host({ timeoutMs: 1000 });
    let signal: AbortSignal | undefined;
    h.register("slow_dig", (_args, _call, s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    const done = h.handle({ id: "s", op: "slow_dig" });
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(signal?.aborted).toBe(true);
  });

  it("stops answering a removed op", async () => {
    const { h, responses } = host();
    const off = h.register("dig", () => "dug");
    off();
    await h.handle({ id: "z", op: "dig" });
    expect(responses[0]!.result.isError).toBe(true);
  });

  it("sends the tab id as a header and reports focus changes once each", async () => {
    vi.useFakeTimers();
    let focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    const reports: { tab: string; focused: boolean }[] = [];
    const { h } = host({ reportFocus: (s) => void reports.push(s) });
    expect(h.headers()).toEqual({ "X-Browser-Tab": h.tabId });
    expect(h.tabId).toMatch(/^[\w-]{16,}$/);
    await vi.advanceTimersByTimeAsync(200);
    focused = false;
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(200);
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(200);
    focused = true;
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(200);
    h.dispose();
    focused = false;
    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(200);
    expect(reports).toEqual([
      { tab: h.tabId, focused: true },
      { tab: h.tabId, focused: false },
      { tab: h.tabId, focused: true },
    ]);
  });
});
