import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { componentAi } from "../../test/component-ai";
import type { AiConnection } from "../backend/types";
import AiLoginCard from "./AiLoginCard.vue";

const connection: AiConnection = { id: "otter-plan", kind: "subscription", dialect: "responses", name: "Otter plan", connected: false, enabled: true, login: "device" };

describe("AiLoginCard", () => {
  it("refuses sign-in addresses that are not web links", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const ai = componentAi({}, { startLogin: async () => ({ kind: "device", url: "javascript:alert(1)", code: "OTTR-1234", interval: 5 }) });
    const w = mount(AiLoginCard, { props: { connection, ai } });
    await w.find("button").trigger("click");
    await flushPromises();
    expect(w.find(".ai-card-error").text()).toBe("The sign-in address is not a web link.");
    expect(w.text()).not.toContain("OTTR-1234");
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
