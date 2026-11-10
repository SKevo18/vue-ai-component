import { parseArgs, parseJson } from "../core/sse";
import { AiError, type ChatRequest, type ChatResponse, type Message, type OnDelta, type SseEvent, type StreamParser, type ToolCall, type Usage } from "../core/types";

const THINKING_MODELS = /claude-(sonnet|opus|haiku)-(4|[5-9])|claude-3-7/;
const THINKING_BUDGET = 2048;

/** thinking blocks go back on the next turn exactly as received (the signature is verified) */
type ThinkingBlock = { type: "thinking"; thinking: string; signature: string } | { type: "redacted_thinking"; data: string };
type CacheControl = { type: "ephemeral" };

type Block =
  | ThinkingBlock
  | { type: "text"; text: string; cache_control?: CacheControl }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: CacheControl }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; cache_control?: CacheControl }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; cache_control?: CacheControl };

interface WireMessage {
  role: "user" | "assistant";
  content: Block[];
}

interface AnthropicUsage {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

interface StreamEvent {
  type: string;
  index?: number;
  message?: { usage?: AnthropicUsage };
  content_block?: { type: string; id?: string; name?: string; text?: string; thinking?: string; data?: string };
  delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; stop_reason?: string };
  usage?: AnthropicUsage;
  error?: { message?: string; type?: string };
}

function isThinkingBlock(v: unknown): v is ThinkingBlock {
  if (!v || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (b.type === "thinking" && typeof b.thinking === "string" && typeof b.signature === "string") || (b.type === "redacted_thinking" && typeof b.data === "string");
}

/** strictly alternating roles: consecutive same-role turns merge; thinking blocks of earlier turns are replayed */
export function toAnthropicMessages(messages: Message[], thinking: boolean): WireMessage[] {
  const out: WireMessage[] = [];
  const push = (role: WireMessage["role"], blocks: Block[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "user") {
      push("user", [{ type: "text", text: m.content || " " }, ...(m.images ?? []).map((i): Block => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } }))]);
    } else if (m.role === "assistant") {
      const blocks: Block[] = [];
      const replay = m.meta?.thinking;
      if (thinking && Array.isArray(replay)) blocks.push(...replay.filter(isThinkingBlock));
      if (m.content.trim()) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      if (blocks.length) push("assistant", blocks);
    } else push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content || " ", is_error: m.isError || undefined }]);
  }
  return out;
}

/**
 * cache breakpoints on the last block of the two newest messages (plus the system prompt), so every request of an
 * agent run reads the previous one's prefix from the cache. Three of the four allowed breakpoints.
 */
function withCacheBreakpoints(messages: WireMessage[]): WireMessage[] {
  return messages.map((m, i) => {
    if (i < messages.length - 2) return m;
    const at = m.content.findLastIndex((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    if (at < 0) return m;
    return { ...m, content: m.content.map((b, j) => (j === at ? { ...b, cache_control: { type: "ephemeral" } } : b)) };
  });
}

export function messagesBody(req: ChatRequest): Record<string, unknown> {
  const thinking = THINKING_MODELS.test(req.model);
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: /claude-3-(?!7)/.test(req.model) ? 4096 : 32000,
    system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
    messages: withCacheBreakpoints(toAnthropicMessages(req.messages, thinking)),
    stream: true,
  };
  if (thinking) body.thinking = { type: "enabled", budget_tokens: THINKING_BUDGET };
  if (req.tools.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: { ...t.parameters, type: "object" } }));
  return body;
}

type Slot = { kind: "text" } | { kind: "tool"; id: string; name: string; json: string } | { kind: "thinking"; block: ThinkingBlock };

export class MessagesStream implements StreamParser {
  private text = "";
  private reasoning = "";
  private usage?: Usage;
  private raw: AnthropicUsage = {};
  private blocks = new Map<number, Slot>();
  private order: number[] = [];
  private truncated = false;

  push({ event, data }: SseEvent, onDelta?: OnDelta): void {
    const ev = parseJson<StreamEvent>(data);
    if (!ev) return;
    switch (ev.type || event) {
      case "message_start":
        if (ev.message?.usage) this.addUsage(ev.message.usage);
        break;
      case "content_block_start": {
        const idx = ev.index ?? 0;
        const cb = ev.content_block;
        if (cb?.type === "tool_use") this.open(idx, { kind: "tool", id: cb.id ?? "", name: cb.name ?? "", json: "" });
        else if (cb?.type === "thinking") this.open(idx, { kind: "thinking", block: { type: "thinking", thinking: cb.thinking ?? "", signature: "" } });
        else if (cb?.type === "redacted_thinking") this.open(idx, { kind: "thinking", block: { type: "redacted_thinking", data: cb.data ?? "" } });
        else {
          this.blocks.set(idx, { kind: "text" });
          if (cb?.text) {
            this.text += cb.text;
            onDelta?.(cb.text, "text");
          }
        }
        break;
      }
      case "content_block_delta": {
        const block = this.blocks.get(ev.index ?? 0);
        const d = ev.delta;
        if (d?.type === "text_delta" && d.text) {
          this.text += d.text;
          onDelta?.(d.text, "text");
        } else if (d?.type === "input_json_delta" && block?.kind === "tool") block.json += d.partial_json ?? "";
        else if (d?.type === "thinking_delta" && block?.kind === "thinking" && block.block.type === "thinking" && d.thinking) {
          block.block.thinking += d.thinking;
          this.reasoning += d.thinking;
          onDelta?.(d.thinking, "reasoning");
        } else if (d?.type === "signature_delta" && block?.kind === "thinking" && block.block.type === "thinking") block.block.signature += d.signature ?? "";
        break;
      }
      case "message_delta":
        if (ev.usage) this.addUsage(ev.usage);
        if (ev.delta?.stop_reason === "max_tokens") this.truncated = true;
        break;
      case "error": {
        const t = ev.error?.type;
        throw new AiError(t === "rate_limit_error" ? "rate_limit" : t === "overloaded_error" || t === "api_error" ? "server" : "unknown", ev.error?.message || "stream error", undefined, t);
      }
    }
  }

  private open(idx: number, slot: Slot) {
    this.blocks.set(idx, slot);
    this.order.push(idx);
  }

  private addUsage(u: AnthropicUsage) {
    for (const [k, v] of Object.entries(u)) if (typeof v === "number") this.raw[k as keyof AnthropicUsage] = v;
    const r = this.raw;
    const cached = r.cache_read_input_tokens ?? 0;
    this.usage = { input: (r.input_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0) + cached, output: r.output_tokens ?? 0 };
    if (cached) this.usage.cached = cached;
  }

  response(): ChatResponse {
    const toolCalls: ToolCall[] = [];
    const thinking: ThinkingBlock[] = [];
    for (const idx of this.order) {
      const b = this.blocks.get(idx);
      if (b?.kind === "tool") toolCalls.push({ id: b.id || `toolu_${idx}`, name: b.name, args: parseArgs(b.json) });
      else if (b?.kind === "thinking") thinking.push(b.block);
    }
    const res: ChatResponse = { text: this.text, toolCalls, usage: this.usage };
    if (this.truncated) res.truncated = true;
    if (this.reasoning) res.reasoning = this.reasoning;
    if (thinking.length) res.meta = { thinking };
    return res;
  }
}
