import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { componentAi } from "../../test/component-ai";
import type { PendingApproval } from "../ai";
import { approvalDiff } from "../ui/approval-diff";
import AiApproval from "./AiApproval.vue";

const pending = (over: Partial<PendingApproval> = {}): PendingApproval => ({ toolCallId: "c", tool: "paint_badger", title: "Paint the sett", approval: "ask", args: { color: "blue", hidden: "still visible in arguments" }, ...over });

describe("AiApproval", () => {
  it("renders app summaries, categories, labelled fields and before/after as escaped text", () => {
    const w = mount(AiApproval, { props: { ai: componentAi(), approval: pending({ preview: { summary: "<img src=x onerror=alert(1)>", categoryHint: "Private painting only", fields: [{ label: "Coat", value: "<script>badger()</script>" }], before: "moss\nbrown", after: "moss\nblue" } }) } });
    expect(w.text()).toContain("Private painting only");
    expect(w.text()).toContain("<img src=x onerror=alert(1)>");
    expect(w.find(".ai-approval-fields").text()).toContain("Coat");
    expect(w.find(".ai-approval-fields").text()).toContain("<script>badger()</script>");
    expect(w.find("img").exists()).toBe(false);
    expect(w.find("script").exists()).toBe(false);
    expect(w.find(".ai-diff-del").text()).toBe("− brown");
    expect(w.find(".ai-diff-add").text()).toBe("+ blue");
    expect(w.find(".ai-approval-diff").text()).toContain("1 lines added, 1 lines removed");
    expect(w.find("details").text()).toContain("still visible in arguments");
  });

  it("retains raw arguments on failed previews and all three approval decisions", async () => {
    const ai = componentAi();
    const decide = vi.spyOn(ai, "decide");
    const w = mount(AiApproval, { props: { ai, approval: pending({ previewError: true }) } });
    expect(w.text()).toContain("preview could not be loaded");
    expect(w.find(".ai-approval-args").text()).toContain("still visible in arguments");
    for (const button of w.findAll("button")) await button.trigger("click");
    expect(decide.mock.calls).toEqual([["deny"], ["always"], ["approve"]]);
  });

  it("offers no lasting approval for confirm-tier tools", () => {
    const w = mount(AiApproval, { props: { ai: componentAi(), approval: pending({ approval: "confirm" }) } });
    expect(w.findAll("button").map((b) => b.text())).toEqual(["Deny", "Approve"]);
  });

  it("keeps focus in a text field the user is typing in", () => {
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    const typing = mount(AiApproval, { props: { ai: componentAi(), approval: pending() }, attachTo: document.body });
    expect(document.activeElement).toBe(input);
    typing.unmount();
    input.blur();
    input.remove();
    const idle = mount(AiApproval, { props: { ai: componentAi(), approval: pending() }, attachTo: document.body });
    expect(document.activeElement?.textContent).toContain("Approve");
    idle.unmount();
  });

  it("shows arguments that clear a field", () => {
    const w = mount(AiApproval, { props: { ai: componentAi(), approval: pending({ args: { body: "", due: null } }) } });
    expect(w.find(".ai-approval-args").text()).toContain('body""');
    expect(w.find(".ai-approval-args").text()).toContain("duenull");
  });

  it("distinguishes loading, unchanged content, deletion and a bounded oversized diff", async () => {
    const w = mount(AiApproval, { props: { ai: componentAi(), approval: pending({ previewLoading: true }) } });
    expect(w.find('[role="status"]').text()).toContain("Loading change preview");
    await w.setProps({ approval: pending({ preview: { before: "badger", after: "badger" } }) });
    expect(w.text()).toContain("No content changes");
    expect(w.find("pre").exists()).toBe(false);
    await w.setProps({ approval: pending({ preview: { before: "badger", after: "" } }) });
    expect(w.find(".ai-diff-del").text()).toBe("− badger");
    await w.setProps({ approval: pending({ preview: { before: "badger\n".repeat(601), after: "otter" } }) });
    expect(w.text()).toContain("Too large for a line diff");
    expect(w.find("pre").exists()).toBe(false);
  });

  it("counts only changed lines and compacts distant unchanged context", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `badger ${index}`);
    const after = [...lines];
    after[15] = "otter";
    const result = approvalDiff(lines.join("\n"), after.join("\n"));
    expect(result).toMatchObject({ added: 1, removed: 1, truncated: false });
    expect(result.rows).toContainEqual({ type: "skip", count: 13 });
    expect(result.rows).toContainEqual({ type: "skip", count: 12 });
  });
});
