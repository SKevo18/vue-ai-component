import { describe, expect, it } from "vitest";
import type { Entry, ToolEntry } from "./entries";
import { ELIDE_AT, elideOld, KEEP_CHARS, prunedResults } from "./pruning";
import type { HarnessTool } from "./tools";

const tools: HarnessTool[] = [
  { name: "read", description: "", parameters: { type: "object" }, approval: "auto", readOnly: true, keep: (a) => String(a.uri).startsWith("skill://"), run: async () => ({ text: "" }) },
  { name: "rename_burrow", description: "", parameters: { type: "object" }, approval: "ask", readOnly: false, run: async () => ({ text: "" }) },
  { name: "list_burrows", description: "", parameters: { type: "object" }, approval: "auto", readOnly: true, run: async () => ({ text: "" }) },
];

let n = 0;
function result(name: string, args: Record<string, unknown>, size: number): ToolEntry {
  return { id: `t${++n}`, role: "tool", toolCallId: `c${n}`, name, args, content: "o".repeat(size), status: "done" };
}

describe("pruning", () => {
  it("marks a read outdated once a later write changes the same resource", () => {
    const read = result("read", { uri: "burrow://2" }, 500);
    const entries: Entry[] = [read, result("rename_burrow", { uri: "burrow://2#name", name: "Fern Den" }, 20), result("read", { uri: "burrow://3" }, 500)];
    const pruned = prunedResults(entries, tools);
    expect(pruned.get(read.id)).toContain("Outdated: burrow://2");
    expect(pruned.size).toBe(1);
  });

  it("leaves reads alone when only read-only tools touched the resource", () => {
    const read = result("read", { uri: "burrow://2" }, 500);
    expect(prunedResults([read, result("list_burrows", { uri: "burrow://2" }, 10)], tools).size).toBe(0);
  });

  it("elides the oldest large results in one batch and keeps the newest", () => {
    const big = Math.ceil(ELIDE_AT / 8);
    const entries: Entry[] = Array.from({ length: 10 }, (_, i) => result("list_burrows", { q: `den ${i}` }, big));
    const marked = elideOld(entries, tools);
    expect(marked).toBeGreaterThan(0);
    const kept = (entries as ToolEntry[]).filter((e) => !e.elided);
    expect(kept.reduce((s, e) => s + e.content.length, 0)).toBeGreaterThanOrEqual(KEEP_CHARS);
    expect((entries[9] as ToolEntry).elided).toBeUndefined();
    expect((entries[0] as ToolEntry).elided).toBe(true);
    expect(prunedResults(entries, tools).get(entries[0]!.id)).toContain('Elided to save context: list_burrows {"q":"den 0"}');
    expect(elideOld(entries, tools)).toBe(0);
  });

  it("never elides skills, the plan or errors", () => {
    const big = ELIDE_AT;
    const skill = result("read", { uri: "skill://burrow-care/SKILL.md" }, big);
    const entries: Entry[] = [skill, result("list_burrows", {}, 10)];
    expect(elideOld(entries, tools)).toBe(0);
    expect(skill.elided).toBeUndefined();
  });
});
