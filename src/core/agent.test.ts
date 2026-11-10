import { afterEach, describe, expect, it, vi } from "vitest";
import { repairEntries, runAgent, type AgentRun } from "./agent";
import type { Entry, ToolEntry } from "./entries";
import { planTool } from "./builtins";
import type { HarnessTool } from "./tools";
import { AiError, type ChatRequest, type ChatResponse } from "./types";

let n = 0;
const newId = () => `e${++n}`;

function tool(name: string, overrides: Partial<HarnessTool> = {}): HarnessTool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: { id: { type: "integer" } } },
    approval: "auto",
    readOnly: false,
    run: async (args) => ({ text: `${name} ${JSON.stringify(args)}` }),
    ...overrides,
  };
}

function setup(replies: (ChatResponse | Error | ((req: ChatRequest) => ChatResponse))[], tools: HarnessTool[], extra: Partial<AgentRun> = {}) {
  const requests: ChatRequest[] = [];
  const entries: Entry[] = [{ id: newId(), role: "user", content: "count the badgers" }];
  const run: AgentRun = {
    chat: async (req) => {
      requests.push(structuredClone(req));
      const next = replies.shift();
      if (!next) throw new Error("no more replies");
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next(req) : next;
    },
    model: "otter-1",
    dialect: "responses",
    system: "be brief",
    tools,
    entries,
    needsApproval: (t) => t.approval !== "auto",
    confirm: async () => true,
    loadImage: async (ref) => ({ mimeType: "image/png", data: `img:${ref.uri}` }),
    context: { conversationId: "c1", saveImage: async () => ({ uri: "attachment://x" }) },
    signal: new AbortController().signal,
    newId,
    ...extra,
  };
  return { run, requests, entries };
}

const call = (name: string, args: Record<string, unknown> = {}, id = `c${++n}`) => ({ id, name, args });
const toolEntries = (entries: Entry[]) => entries.filter((e): e is ToolEntry => e.role === "tool");

afterEach(() => vi.useRealTimers());

describe("runAgent", () => {
  it("runs tool calls and loops until the model answers without tools", async () => {
    const { run, requests, entries } = setup([{ text: "", toolCalls: [call("count_badgers", { id: 3 })] }, { text: "There are 3.", toolCalls: [] }], [tool("count_badgers")]);
    await runAgent(run);
    expect(toolEntries(entries)[0]).toMatchObject({ status: "done", content: 'count_badgers {"id":3}' });
    expect(entries.at(-1)).toMatchObject({ role: "assistant", content: "There are 3." });
    expect(requests[1]!.messages.at(-1)).toMatchObject({ role: "tool", content: 'count_badgers {"id":3}' });
  });

  it("asks before calls that need approval and reports a rejection to the model", async () => {
    const confirm = vi.fn(async () => false);
    const fill = vi.fn(async () => ({ text: "filled" }));
    const { run, entries } = setup([{ text: "", toolCalls: [call("fill_burrow", { id: 1 })] }, { text: "Okay, I left it.", toolCalls: [] }], [tool("fill_burrow", { approval: "confirm", run: fill })], { confirm });
    await runAgent(run);
    expect(confirm).toHaveBeenCalledOnce();
    expect(fill).not.toHaveBeenCalled();
    expect(toolEntries(entries)[0]).toMatchObject({ status: "rejected", isError: true });
  });

  it("runs consecutive read-only calls in parallel and others one by one", async () => {
    const log: string[] = [];
    const slow = (name: string, readOnly: boolean) =>
      tool(name, {
        readOnly,
        run: async () => {
          log.push(`start ${name}`);
          await Promise.resolve();
          log.push(`end ${name}`);
          return { text: name };
        },
      });
    const { run } = setup(
      [{ text: "", toolCalls: [call("peek_a"), call("peek_b"), call("dig")] }, { text: "done", toolCalls: [] }],
      [slow("peek_a", true), slow("peek_b", true), slow("dig", false)],
    );
    await runAgent(run);
    expect(log).toEqual(["start peek_a", "start peek_b", "end peek_a", "end peek_b", "start dig", "end dig"]);
  });

  it("asks for read-only calls that need approval one at a time", async () => {
    const log: string[] = [];
    const confirm = vi.fn(async (t: HarnessTool) => {
      log.push(`ask ${t.name}`);
      await Promise.resolve();
      log.push(`answer ${t.name}`);
      return true;
    });
    const peek = (name: string) => tool(name, { readOnly: true, approval: "ask", run: async () => (log.push(`run ${name}`), { text: name }) });
    const { run } = setup([{ text: "", toolCalls: [call("peek_a"), call("peek_b")] }, { text: "done", toolCalls: [] }], [peek("peek_a"), peek("peek_b")], { confirm });
    await runAgent(run);
    expect(log).toEqual(["ask peek_a", "answer peek_a", "run peek_a", "ask peek_b", "answer peek_b", "run peek_b"]);
  });

  it("refuses the fifth identical call in a row", async () => {
    const replies = Array.from({ length: 5 }, () => ({ text: "", toolCalls: [call("count_badgers", { id: 9 })] }));
    const { run, entries } = setup([...replies, { text: "giving up", toolCalls: [] }], [tool("count_badgers")]);
    await runAgent(run);
    const results = toolEntries(entries);
    expect(results.slice(0, 4).every((e) => e.status === "done")).toBe(true);
    expect(results[4]).toMatchObject({ isError: true });
    expect(results[4]!.content).toContain("5 times in a row");
  });

  it("never runs a call cut off by the output limit", async () => {
    const dig = vi.fn(async () => ({ text: "dug" }));
    const { run, entries } = setup([{ text: "", toolCalls: [call("count_badgers"), call("dig", { id: 1 })], truncated: true }, { text: "ok", toolCalls: [] }], [tool("count_badgers"), tool("dig", { run: dig })]);
    await runAgent(run);
    expect(dig).not.toHaveBeenCalled();
    const results = toolEntries(entries);
    expect(results[0]!.status).toBe("done");
    expect(results[1]).toMatchObject({ name: "dig", isError: true });
  });

  it("retries network and server errors after a pause", async () => {
    vi.useFakeTimers();
    const { run, entries } = setup([new AiError("network", "otters cut the cable"), new AiError("server", "burrow flooded"), { text: "back", toolCalls: [] }], []);
    const done = runAgent(run);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(entries.filter((e) => e.role === "assistant")).toHaveLength(1);
    expect(entries.at(-1)).toMatchObject({ content: "back" });
  });

  it("gives up on other errors at once", async () => {
    const { run } = setup([new AiError("auth", "bad badger key")], []);
    await expect(runAgent(run)).rejects.toMatchObject({ kind: "auth" });
  });

  it("reminds the model of open plan steps at most three times", async () => {
    const steps = [
      { text: "find badgers", status: "done" },
      { text: "count otters", status: "pending" },
    ];
    const replies = [{ text: "", toolCalls: [call("update_plan", { steps })] }, ...Array.from({ length: 4 }, () => ({ text: "I stopped.", toolCalls: [] }))];
    const { run, entries } = setup(replies, [planTool]);
    await runAgent(run);
    expect(entries.filter((e) => e.role === "reminder")).toHaveLength(3);
  });

  it("does not remind when the answer is a question", async () => {
    const steps = [{ text: "count otters", status: "pending" }];
    const { run, entries } = setup([{ text: "", toolCalls: [call("update_plan", { steps })] }, { text: "Which river?", toolCalls: [] }], [planTool]);
    await runAgent(run);
    expect(entries.some((e) => e.role === "reminder")).toBe(false);
  });

  it("sends tool images as visual input after the tool results", async () => {
    const photo = tool("burrow_photo", { readOnly: true, run: async () => ({ text: "photo", images: [{ uri: "attachment://p1" }] }) });
    const { run, requests } = setup([{ text: "", toolCalls: [call("burrow_photo", { id: 1 })] }, { text: "A brown burrow.", toolCalls: [] }], [photo]);
    await runAgent(run);
    const last = requests[1]!.messages;
    expect(last.at(-2)).toMatchObject({ role: "tool" });
    expect(last.at(-1)).toMatchObject({ role: "user", images: [{ data: "img:attachment://p1" }] });
  });

  it("answers unknown tools and invalid arguments with errors the model reads", async () => {
    const { run, entries } = setup(
      [{ text: "", toolCalls: [call("summon_heron"), call("count_badgers", { id: "many" })] }, { text: "sorry", toolCalls: [] }],
      [tool("count_badgers")],
    );
    await runAgent(run);
    const [unknown, invalid] = toolEntries(entries);
    expect(unknown!.content).toContain("Unknown tool summon_heron");
    expect(invalid!.content).toContain("id must be a number");
  });

  it("replays provider blocks only to the dialect that produced them", async () => {
    const { run, requests, entries } = setup([{ text: "fresh", toolCalls: [] }], []);
    entries.unshift({ id: "a0", role: "assistant", content: "earlier", toolCalls: [], meta: { thinking: ["sig"] }, dialect: "messages" });
    await runAgent(run);
    expect(requests[0]!.messages[0]).toMatchObject({ role: "assistant", meta: undefined });
  });
});

describe("repairEntries", () => {
  it("answers interrupted calls so strict providers accept the history", () => {
    const repaired = repairEntries(
      [
        { id: "u", role: "user", content: "hi" },
        { id: "a", role: "assistant", content: "", toolCalls: [call("dig", {}, "k1")], streaming: true },
        { id: "s", role: "assistant", content: "", toolCalls: [], streaming: true },
      ],
      () => "new",
    );
    expect(repaired.map((e) => e.role)).toEqual(["user", "assistant", "tool"]);
    expect(repaired[2]).toMatchObject({ toolCallId: "k1", isError: true, content: "Interrupted." });
  });
});
