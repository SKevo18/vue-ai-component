import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { componentAi } from "../../test/component-ai";
import AiSidebar from "./AiSidebar.vue";

describe("AiSidebar", () => {
  it("names each failing MCP server in the tools notice and closes it", async () => {
    const ai = componentAi({ mcp: { docs: { url: "/docs/mcp", name: "Docs" }, den: { url: "/den/mcp" } } });
    await ai.init();
    const w = mount(AiSidebar, { props: { ai } });
    await flushPromises();
    ai.state.mcp.docs!.error = "Cannot reach the MCP server: offline";
    ai.state.mcp.den!.error = "HTTP 502";
    await flushPromises();
    const notice = w.find(".ai-notice");
    expect(notice.findAll(".ai-failure").map((s) => s.text())).toEqual(["Tools from Docs are unavailable.", "Tools from den are unavailable."]);
    expect(notice.text()).not.toContain("offline");
    await notice.find("button").trigger("click");
    expect(w.find(".ai-notice").exists()).toBe(false);
    ai.state.mcp.den!.error = "HTTP 503";
    await flushPromises();
    expect(w.find(".ai-notice").exists()).toBe(true);
    w.unmount();
  });
});
