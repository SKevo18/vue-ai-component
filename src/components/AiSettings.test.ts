import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createAi } from "../ai";
import type { AiBackend, AiConnection } from "../backend/types";
import AiSettings from "./AiSettings.vue";

const connection = (over: Partial<AiConnection>): AiConnection => ({ id: "x", kind: "key", dialect: "responses", name: "X", connected: false, enabled: true, ...over });

function settings(backend: AiBackend) {
  return createAi({
    backend,
    conversations: { list: async () => [], load: async () => null, save: async () => undefined, remove: async () => undefined },
    preferences: { load: async () => ({}), save: async () => undefined },
  });
}

describe("AiSettings", () => {
  it("shows descriptions and warnings on every card, connected or not", async () => {
    const ai = createAi({
      backend: {
        connections: async () => [
          connection({ id: "site", kind: "site", name: "Otter school", connected: true, description: "The school pays for otter questions." }),
          connection({ id: "otter-plan", kind: "subscription", login: "paste", name: "Otter plan", connected: true, account: "ollie@river.example", description: "Tokens are sealed with a key only this browser has.", warning: "The vendor's terms may forbid this outside their apps." }),
          connection({ id: "openai", name: "OpenAI", warning: "Keys are billed per badger." }),
        ],
        models: async () => [{ id: "otter-1" }],
        transport: () => async () => new Response(""),
        saveKey: async () => undefined,
      },
      conversations: { list: async () => [], load: async () => null, save: async () => undefined, remove: async () => undefined },
      preferences: { load: async () => ({}), save: async () => undefined },
      storagePrefix: "settings-test:",
    });
    const wrapper = mount(AiSettings, { props: { ai } });
    await flushPromises();
    const descriptions = wrapper.findAll(".ai-card-desc").map((p) => p.text());
    const warnings = wrapper.findAll(".ai-card-warning").map((p) => p.text());
    expect(descriptions).toEqual(["The school pays for otter questions.", "Tokens are sealed with a key only this browser has."]);
    expect(warnings).toEqual(["The vendor's terms may forbid this outside their apps.", "Keys are billed per badger."]);
    expect(wrapper.text()).toContain("ollie@river.example");
  });
  it("keeps disabled connected key and subscription cards disconnectable but excludes them from selection", async () => {
    const connections = [
      connection({ id: "disabled-key", name: "Disabled key", connected: true, enabled: false }),
      connection({ id: "disabled-login", kind: "subscription", name: "Disabled login", connected: true, enabled: false }),
      connection({ id: "hidden", name: "Hidden provider", enabled: false }),
      connection({ id: "available", name: "Available provider", connected: true }),
    ];
    const saveKey = vi.fn(async (id: string) => { connections.find((c) => c.id === id)!.connected = false; });
    const logout = vi.fn(async (id: string) => { connections.find((c) => c.id === id)!.connected = false; });
    const ai = settings({ connections: async () => connections.map((c) => ({ ...c })), models: async () => [{ id: "model-1" }], transport: () => async () => new Response(""), saveKey, logout });
    const wrapper = mount(AiSettings, { props: { ai } });
    await flushPromises();
    expect(wrapper.findAll(".ai-card-title").map((node) => node.text())).toEqual(["Disabled login", "Disabled key", "Available provider"]);
    expect(wrapper.findAll('[role="radio"]').map((node) => node.text())).toEqual(["Available provider"]);
    expect(ai.connection?.id).toBe("available");
    const keyCard = wrapper.findAll(".ai-card").find((node) => node.text().includes("Disabled key"))!;
    await keyCard.get('button[aria-label="Remove key"]').trigger("click");
    await flushPromises();
    expect(saveKey).toHaveBeenCalledWith("disabled-key", null);
    expect(wrapper.text()).not.toContain("Disabled key");
    const loginCard = wrapper.findAll(".ai-card").find((node) => node.text().includes("Disabled login"))!;
    await loginCard.get("button").trigger("click");
    await loginCard.get("button.ai-danger").trigger("click");
    await flushPromises();
    expect(logout).toHaveBeenCalledWith("disabled-login");
    expect(wrapper.text()).not.toContain("Disabled login");
    wrapper.unmount();
  });

  it("does not show an empty-state hint for a disabled connected card and offers no provider/model selection", async () => {
    const ai = settings({
      connections: async () => [connection({ connected: true, enabled: false })],
      models: vi.fn(async () => []),
      transport: () => async () => new Response(""),
      saveKey: async () => undefined,
    });
    const wrapper = mount(AiSettings, { props: { ai } });
    await flushPromises();
    expect(wrapper.find(".ai-card").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("No AI provider is available.");
    expect(wrapper.find('[role="radio"]').exists()).toBe(false);
    expect(wrapper.find("select").exists()).toBe(false);
    expect(ai.options.backend.models).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("requires explicit browser-key confirmation, supports cancellation, then refreshes cards", async () => {
    let connected = true;
    const clearBrowserKeys = vi.fn(async () => { connected = false; });
    const ai = settings({
      connections: async () => [connection({ connected })],
      models: async () => [{ id: "model-1" }],
      transport: () => async () => new Response(""),
      clearBrowserKeys,
    });
    const wrapper = mount(AiSettings, { props: { ai } });
    await flushPromises();
    const clear = wrapper.get(".ai-browser-keys-clear");
    await clear.get("button").trigger("click");
    expect(clearBrowserKeys).not.toHaveBeenCalled();
    expect(clear.text()).toContain("Server keys and signed-in accounts will not be changed.");
    await clear.findAll("button")[1]!.trigger("click");
    expect(clearBrowserKeys).not.toHaveBeenCalled();
    expect(clear.text()).not.toContain("Server keys");
    await clear.get("button").trigger("click");
    await clear.get("button.ai-danger").trigger("click");
    await flushPromises();
    expect(clearBrowserKeys).toHaveBeenCalledTimes(1);
    expect(wrapper.find(".ai-card-status").text()).toBe("Not connected");
    expect(wrapper.find('[role="radio"]').exists()).toBe(false);
    expect(clear.text()).not.toContain("Server keys");
    wrapper.unmount();
  });

  it("reports browser-key clearing failures without claiming the keys were removed", async () => {
    const ai = settings({
      connections: async () => [connection({ connected: true })],
      models: async () => [{ id: "model-1" }],
      transport: () => async () => new Response(""),
      clearBrowserKeys: async () => { throw new Error("Storage denied"); },
    });
    const wrapper = mount(AiSettings, { props: { ai } });
    await flushPromises();
    await wrapper.get(".ai-browser-keys-clear button").trigger("click");
    await wrapper.get(".ai-browser-keys-clear button.ai-danger").trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toBe("Storage denied");
    expect(wrapper.get(".ai-browser-keys-clear").text()).toContain("Server keys");
    expect(wrapper.get(".ai-card-status").text()).toBe("Connected");
    wrapper.unmount();
  });

  it("does not offer browser-key clearing for server-only backends", async () => {
    const ai = settings({
      connections: async () => [connection({ connected: true })],
      models: async () => [{ id: "model-1" }],
      transport: () => async () => new Response(""),
      saveKey: async () => undefined,
    });
    const wrapper = mount(AiSettings, { props: { ai } });
    await flushPromises();
    expect(wrapper.find(".ai-browser-keys-clear").exists()).toBe(false);
    wrapper.unmount();
  });
});
