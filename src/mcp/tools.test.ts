import { describe, expect, it } from "vitest";
import { TOOL_RESULT_LIMIT } from "../core/tools";
import { toolApproval, toolResult } from "./tools";
import type { McpTool } from "./types";

const base: McpTool = { name: "badger_tool", inputSchema: { type: "object" } };

describe("toolApproval", () => {
  it("takes _meta.approval over the annotations", () => {
    expect(toolApproval({ ...base, _meta: { approval: "auto" }, annotations: { destructiveHint: true } })).toBe("auto");
    expect(toolApproval({ ...base, _meta: { approval: "confirm" }, annotations: { readOnlyHint: true } })).toBe("confirm");
  });

  it("derives approval from the annotations", () => {
    expect(toolApproval({ ...base, annotations: { readOnlyHint: true } })).toBe("auto");
    expect(toolApproval({ ...base, annotations: { readOnlyHint: true, openWorldHint: true } })).toBe("ask");
    expect(toolApproval({ ...base, annotations: { openWorldHint: true } })).toBe("confirm");
    expect(toolApproval({ ...base, annotations: { destructiveHint: true } })).toBe("confirm");
    expect(toolApproval({ ...base, annotations: { idempotentHint: true } })).toBe("ask");
    expect(toolApproval(base)).toBe("ask");
  });

  it("ignores unknown approval values", () => {
    expect(toolApproval({ ...base, _meta: { approval: "maybe" }, annotations: { readOnlyHint: true } })).toBe("auto");
  });
});

describe("toolResult", () => {
  const saved: string[] = [];
  const ctx = { saveImage: async (img: { data: string }) => (saved.push(img.data), { uri: `attachment://img${saved.length}` }) };

  it("passes text on, stores images and lists resource links", async () => {
    const r = await toolResult(
      {
        content: [
          { type: "text", text: "Photo of burrow 1." },
          { type: "image", mimeType: "image/png", data: "iVBORbadger" },
          { type: "resource_link", uri: "burrow://1", name: "burrow-1", title: "Mossy Hollow" },
        ],
      },
      ctx,
    );
    expect(saved).toEqual(["iVBORbadger"]);
    expect(r.images).toEqual([{ uri: "attachment://img1" }]);
    expect(r.links).toEqual([{ uri: "burrow://1", name: "burrow-1", title: "Mossy Hollow", mimeType: undefined }]);
    expect(r.text).toContain("Photo of burrow 1.");
    expect(r.text).toContain("burrow://1 (Mossy Hollow)");
    expect(r.isError).toBeUndefined();
  });

  it("keeps the error flag and falls back to structured content", async () => {
    expect(await toolResult({ content: [{ type: "text", text: "No burrow 7." }], isError: true }, ctx)).toMatchObject({ text: "No burrow 7.", isError: true });
    expect((await toolResult({ content: [], structuredContent: { otters: 2 } }, ctx)).text).toBe('{"otters":2}');
  });

  it("cuts long text with a note pointing at the linked resource", async () => {
    const r = await toolResult({ content: [{ type: "text", text: "x".repeat(TOOL_RESULT_LIMIT + 50) }, { type: "resource_link", uri: "burrow://big" }] }, ctx);
    expect(r.text.length).toBeLessThan(TOOL_RESULT_LIMIT + 300);
    expect(r.text).toContain("Read burrow://big for the full content.");
  });
});
