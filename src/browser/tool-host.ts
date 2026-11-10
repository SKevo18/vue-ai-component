import type { McpContent } from "../mcp/types";
import { randomId } from "../core/ids";

export interface BrowserCall {
  id: string;
  op: string;
  arguments?: Record<string, unknown>;
}

export interface BrowserCallResult {
  content: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * returns a string (text), a full result, or any JSON value (sent as JSON text); throws for errors. `signal` aborts
 * when the call times out.
 */
export type BrowserHandler = (args: Record<string, unknown>, call: BrowserCall, signal: AbortSignal) => unknown;

export interface BrowserToolHostOptions {
  respond(callId: string, result: BrowserCallResult): unknown;
  reportFocus?(state: { tab: string; focused: boolean }): unknown;
  /** ms before a handler counts as failed, default 30000 */
  timeoutMs?: number;
  tabId?: string;
}

export interface BrowserToolHost {
  readonly tabId: string;
  register(op: string, handler: BrowserHandler, options?: { timeoutMs?: number }): () => void;
  handle(call: unknown): Promise<void>;
  headers(): Record<string, string>;
  dispose(): void;
}

function toResult(value: unknown): BrowserCallResult {
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  if (value && typeof value === "object" && Array.isArray((value as BrowserCallResult).content)) {
    const r = value as BrowserCallResult;
    const out: BrowserCallResult = { content: r.content };
    if (r.structuredContent && typeof r.structuredContent === "object" && !Array.isArray(r.structuredContent)) out.structuredContent = r.structuredContent;
    if (r.isError) out.isError = true;
    return out;
  }
  return { content: [{ type: "text", text: value === undefined ? "Done." : JSON.stringify(value) }] };
}

function failure(message: string): BrowserCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function parseCall(raw: unknown): BrowserCall | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== "string" || !c.id || typeof c.op !== "string" || !c.op) return null;
  const args = c.arguments && typeof c.arguments === "object" && !Array.isArray(c.arguments) ? (c.arguments as Record<string, unknown>) : {};
  return { id: c.id, op: c.op, arguments: args };
}

export function createBrowserToolHost(options: BrowserToolHostOptions): BrowserToolHost {
  const tabId = options.tabId ?? randomId(16);
  const handlers = new Map<string, { run: BrowserHandler; timeoutMs?: number }>();
  const seen = new Set<string>();
  let lastFocus: boolean | null = null;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;

  const focused = () => typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
  const sendFocus = () => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
      const now = focused();
      if (now === lastFocus) return;
      lastFocus = now;
      void Promise.resolve()
        .then(() => options.reportFocus?.({ tab: tabId, focused: now }))
        .catch(() => {
          lastFocus = null;
        });
    }, 150);
  };
  const events: [EventTarget, string][] = [];
  if (options.reportFocus && typeof window !== "undefined") {
    events.push([window, "focus"], [window, "blur"], [document, "visibilitychange"]);
    for (const [target, name] of events) target.addEventListener(name, sendFocus);
    sendFocus();
  }

  async function run(call: BrowserCall): Promise<BrowserCallResult> {
    const entry = handlers.get(call.op);
    if (!entry) return failure(`This tab cannot run ${call.op}. Reload the page and try again.`);
    const ms = entry.timeoutMs ?? options.timeoutMs ?? 30000;
    const controller = new AbortController();
    const timeout = Promise.withResolvers<BrowserCallResult>();
    const timer = setTimeout(() => {
      controller.abort(new DOMException(`${call.op} timed out`, "TimeoutError"));
      timeout.resolve(failure(`${call.op} did not finish within ${Math.round(ms / 1000)} s.`));
    }, ms);
    try {
      return await Promise.race([Promise.resolve().then(() => entry.run(call.arguments ?? {}, call, controller.signal)).then(toResult), timeout.promise]);
    } catch (e) {
      return failure((e instanceof Error ? e.message : String(e)) || `${call.op} failed.`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    tabId,
    register(op, handler, opts = {}) {
      const entry = { run: handler, timeoutMs: opts.timeoutMs };
      handlers.set(op, entry);
      return () => {
        if (handlers.get(op) === entry) handlers.delete(op);
      };
    },
    async handle(raw) {
      const call = parseCall(raw);
      if (!call || seen.has(call.id)) return;
      seen.add(call.id);
      if (seen.size > 500) seen.delete(seen.values().next().value!);
      const result = await run(call);
      try {
        await options.respond(call.id, result);
      } catch (e) {
        console.warn(`browser call ${call.op} could not be answered`, e);
      }
    },
    headers: () => ({ "X-Browser-Tab": tabId }),
    dispose() {
      clearTimeout(focusTimer);
      for (const [target, name] of events) target.removeEventListener(name, sendFocus);
      events.length = 0;
    },
  };
}
