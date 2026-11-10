import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import { createAi } from "../ai";
import type { AiBackend, AiConnection } from "../backend/types";
import AiKeyCard from "./AiKeyCard.vue";

const connection = (over: Partial<AiConnection> = {}): AiConnection => ({ id: "openai", kind: "key", dialect: "responses", name: "OpenAI", connected: true, enabled: true, ...over });

function setup(over: Partial<AiConnection> = {}, methods: Partial<AiBackend> = {}) {
  const backend: AiBackend = {
    connections: async () => [connection(over)],
    models: vi.fn(async () => [{ id: "gpt-1" }, { id: "gpt-2" }]),
    saveKey: vi.fn(async () => undefined),
    transport: () => async () => new Response(""),
    ...methods,
  };
  const ai = createAi({
    backend,
    preferences: { load: async () => ({}), save: async () => undefined },
    conversations: { list: async () => [], load: async () => null, save: async () => undefined, remove: async () => undefined },
  });
  return { backend, wrapper: mount(AiKeyCard, { props: { ai, connection: connection(over) } }) };
}

describe("AiKeyCard", () => {
  it("toggles key visibility without submitting or changing its value and hides it after saving", async () => {
    const { backend, wrapper } = setup({ connected: false });
    const input = wrapper.get("input");
    await input.setValue("secret-key");
    expect(input.attributes("type")).toBe("password");
    await wrapper.get('button[aria-label="Show key"]').trigger("click");
    expect(input.attributes("type")).toBe("text");
    expect((input.element as HTMLInputElement).value).toBe("secret-key");
    expect(backend.saveKey).not.toHaveBeenCalled();
    await wrapper.get('button[aria-label="Hide key"]').trigger("click");
    expect(input.attributes("type")).toBe("password");
    await wrapper.get('button[aria-label="Show key"]').trigger("click");
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(backend.saveKey).toHaveBeenCalledWith("openai", "secret-key");
    expect((input.element as HTMLInputElement).value).toBe("");
    expect(input.attributes("type")).toBe("password");
    wrapper.unmount();
  });

  it("retests the saved key through models even when models were already cached, then reports failures", async () => {
    const models = vi.fn().mockResolvedValueOnce([{ id: "gpt-1" }, { id: "gpt-2" }]).mockRejectedValueOnce(new Error("Key expired"));
    const { backend, wrapper } = setup({}, { models });
    wrapper.props("ai").state.models.openai = { items: [{ id: "cached" }], loading: false, error: "" };
    await wrapper.get("button.ai-btn").trigger("click");
    await flushPromises();
    expect(models).toHaveBeenCalledTimes(1);
    expect(models).toHaveBeenCalledWith("openai");
    expect(wrapper.get('[role="status"]').text()).toBe("Key works. Available models: 2.");
    expect(backend.saveKey).not.toHaveBeenCalled();
    await wrapper.get("button.ai-btn").trigger("click");
    await flushPromises();
    expect(models).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.get('[role="alert"]').text()).toContain("Key expired");
    wrapper.unmount();
  });

  it("disables duplicate tests and disconnect while testing, and reports a successful zero-model response", async () => {
    const { promise, resolve } = Promise.withResolvers<[]>();
    const models = vi.fn(() => promise);
    const { backend, wrapper } = setup({}, { models });
    await wrapper.get("button.ai-btn").trigger("click");
    expect(wrapper.get("button.ai-btn").text()).toBe("Testing key");
    expect(wrapper.get("button.ai-btn").attributes("disabled")).toBeDefined();
    expect(wrapper.get('button[aria-label="Remove key"]').attributes("disabled")).toBeDefined();
    await wrapper.get("button.ai-btn").trigger("click");
    expect(models).toHaveBeenCalledTimes(1);
    expect(backend.saveKey).not.toHaveBeenCalled();
    resolve([]);
    await flushPromises();
    expect(wrapper.get('[role="status"]').text()).toContain("Available models: 0.");
    expect(wrapper.get("button.ai-btn").attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("renders an optional usage link safely for connected key cards", () => {
    const { wrapper } = setup({ usageUrl: "https://vendor.example/usage?account=1" });
    const link = wrapper.get('a[aria-label="View usage"]');
    expect(link.attributes("href")).toBe("https://vendor.example/usage?account=1");
    expect(link.attributes("target")).toBe("_blank");
    expect(link.attributes("rel")).toBe("noopener noreferrer");
    wrapper.unmount();
  });

  it.each(["javascript:alert(1)", "data:text/html,unsafe", "//vendor.example/usage", "/usage", "https://user:password@vendor.example/usage", "not a URL"])("does not render unsafe usage or key links: %s", (url) => {
    const { wrapper } = setup({ usageUrl: url });
    expect(wrapper.find("a").exists()).toBe(false);
    wrapper.unmount();
    const disconnected = setup({ connected: false, keysUrl: url, usageUrl: url }).wrapper;
    expect(disconnected.find("a").exists()).toBe(false);
    disconnected.unmount();
  });

  it("does not restore a test result after browser keys are cleared while a test is pending", async () => {
    const { promise, resolve } = Promise.withResolvers<{ id: string }[]>();
    const { wrapper } = setup({}, { models: () => promise });
    await wrapper.get("button.ai-btn").trigger("click");
    await wrapper.setProps({ connection: connection({ connected: false }) });
    resolve([{ id: "model-1" }]);
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get("input").attributes("type")).toBe("password");
    wrapper.unmount();
  });
});
