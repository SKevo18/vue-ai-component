import { createBrowserKeys, mergeBackends, type AiBackend, type AiConnection, type LoginResult } from "../src";
import { scriptedTransport } from "../test/fake-provider";
import { playgroundScript } from "./script";

export function playgroundBackend(): AiBackend {
  const signedIn = new Set<string>(["scripted"]);
  let polls = 0;
  const scripted = scriptedTransport(playgroundScript, 12);
  const server: AiBackend = {
    async connections(): Promise<AiConnection[]> {
      return [
        { id: "scripted", kind: "site", dialect: "responses", name: "Badger AI", connected: true, enabled: true, note: "Scripted model, no network" },
        { id: "otter-plan", kind: "subscription", dialect: "responses", name: "Otter plan", login: "device", connected: signedIn.has("otter-plan"), account: "ollie@river.example", enabled: true, wire: { reasoning: true } },
        { id: "badger-plan", kind: "subscription", dialect: "responses", name: "Badger plan", login: "paste", connected: signedIn.has("badger-plan"), account: "bea@sett.example", enabled: true },
      ];
    },
    async startLogin(id) {
      polls = 0;
      if (id === "otter-plan") return { kind: "device", url: `${location.origin}/oauth-mock.html?device=1`, code: "OTTR-4821", interval: 1, expiresIn: 120 };
      return { kind: "paste", url: `${location.origin}/oauth-mock.html` };
    },
    async completeLogin(id, pasted): Promise<LoginResult> {
      if (id === "otter-plan") {
        if (++polls < 3) return "pending";
      } else if (!pasted?.startsWith("badger-code-")) throw new Error("That code is not valid. Copy the whole code.");
      signedIn.add(id);
      return "connected";
    },
    async logout(id) {
      signedIn.delete(id);
    },
    async models(id) {
      if (id === "scripted") return [{ id: "scripted-1", name: "Scripted badger" }, { id: "scripted-2", name: "Scripted otter with a very long model name for truncation" }];
      return [{ id: `${id}-otter`, name: `${id} otter` }, { id: `${id}-badger` }];
    },
    transport: () => scripted,
  };
  return mergeBackends(server, createBrowserKeys({ prefix: "playground:" }));
}
