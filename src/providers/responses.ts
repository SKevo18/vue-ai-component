// with store:false the encrypted reasoning items are replayed verbatim so the model keeps its chain
import { parseArgs, parseJson } from "../core/sse";
import { AiError, type ChatRequest, type ChatResponse, type Message, type OnDelta, type SseEvent, type StreamParser, type ToolCall, type ToolSpec, type Usage } from "../core/types";

export interface ResponsesOptions {
  toolNamespace?: string;
  reasoning?: boolean;
}

type InputItem =
  | { role: "user"; content: string | ({ type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail: "auto" })[] }
  | { type: "message"; role: "assistant"; content: { type: "output_text"; text: string }[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string; namespace?: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | ReasoningItem;

interface ReasoningItem {
  type: "reasoning";
  id: string;
  summary: unknown[];
  encrypted_content?: string;
}

interface OutputItem {
  type: string;
  id?: string;
  call_id?: string;
  name?: string;
  namespace?: string;
  arguments?: string;
  summary?: unknown[];
  encrypted_content?: string;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
}

interface StreamEvent {
  type: string;
  delta?: string;
  output_index?: number;
  item?: OutputItem;
  response?: { usage?: ResponsesUsage; error?: { code?: string; message?: string } | null; incomplete_details?: { reason?: string } | null };
  code?: string;
  message?: string;
}

/** models that take reasoning settings; others reject the parameter */
const REASONING_MODELS = /^(o\d|gpt-5|codex)/;

function isReasoningItem(v: unknown): v is ReasoningItem {
  return !!v && typeof v === "object" && (v as ReasoningItem).type === "reasoning" && typeof (v as ReasoningItem).id === "string";
}

export function toResponsesInput(messages: Message[]): InputItem[] {
  const out: InputItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const images = m.images ?? [];
      out.push({
        role: "user",
        content: images.length ? [{ type: "input_text", text: m.content }, ...images.map((i) => ({ type: "input_image" as const, image_url: `data:${i.mimeType};base64,${i.data}`, detail: "auto" as const }))] : m.content,
      });
    } else if (m.role === "assistant") {
      const replay = m.meta?.reasoning;
      if (Array.isArray(replay)) out.push(...replay.filter(isReasoningItem));
      if (m.content.trim()) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const c of m.toolCalls) {
        const item: InputItem = { type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) };
        if (typeof c.meta?.namespace === "string") item.namespace = c.meta.namespace;
        out.push(item);
      }
    } else out.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
  }
  return out;
}

function toResponsesTools(tools: ToolSpec[], namespace?: string) {
  const functions = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
  return namespace ? [{ type: "namespace", name: namespace, description: "Tools of this app.", tools: functions }] : functions;
}

export function responsesBody(req: ChatRequest, options: ResponsesOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    instructions: req.system,
    input: toResponsesInput(req.messages),
    store: false,
    stream: true,
  };
  if (options.reasoning || REASONING_MODELS.test(req.model)) {
    body.reasoning = { effort: "medium", summary: "auto" };
    body.include = ["reasoning.encrypted_content"];
  }
  if (req.cacheKey) body.prompt_cache_key = req.cacheKey;
  if (req.tools.length) body.tools = toResponsesTools(req.tools, options.toolNamespace);
  return body;
}

function toUsage(u: ResponsesUsage): Usage {
  const usage: Usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
  if (u.input_tokens_details?.cached_tokens) usage.cached = u.input_tokens_details.cached_tokens;
  return usage;
}

function failure(code: string | undefined, message: string): AiError {
  const text = code ? `${message} (${code})` : message;
  if (code === "rate_limit_exceeded" || code?.includes("usage_limit")) return new AiError("rate_limit", text, undefined, code);
  if (code === "invalid_api_key" || code?.startsWith("subscription_sharing_") || code?.startsWith("chatpass_")) return new AiError("auth", text, undefined, code);
  return new AiError("server", text, undefined, code);
}

export class ResponsesStream implements StreamParser {
  private text = "";
  private reasoning = "";
  private usage?: Usage;
  private reasoningItems: ReasoningItem[] = [];
  private truncated = false;
  private calls = new Map<number, { id: string; name: string; args: string; namespace?: string }>();

  constructor(private readonly namespace?: string) {}

  push({ data }: SseEvent, onDelta?: OnDelta): void {
    const ev = parseJson<StreamEvent>(data);
    if (!ev) return;
    switch (ev.type) {
      case "response.output_text.delta":
        if (ev.delta) {
          this.text += ev.delta;
          onDelta?.(ev.delta, "text");
        }
        return;
      case "response.reasoning_summary_text.delta":
        if (ev.delta) {
          this.reasoning += ev.delta;
          onDelta?.(ev.delta, "reasoning");
        }
        return;
      case "response.reasoning_summary_part.done":
        this.reasoning += "\n\n";
        onDelta?.("\n\n", "reasoning");
        return;
      case "response.output_item.added":
      case "response.output_item.done":
        // the done item carries the complete arguments and replaces what the deltas accumulated
        if (ev.item?.type === "function_call" && ev.output_index !== undefined) this.calls.set(ev.output_index, this.slot(ev.item));
        else if (ev.type === "response.output_item.done" && ev.item?.type === "reasoning" && ev.item.id) {
          this.reasoningItems.push({ type: "reasoning", id: ev.item.id, summary: ev.item.summary ?? [], encrypted_content: ev.item.encrypted_content });
        }
        return;
      case "response.function_call_arguments.delta":
        if (ev.output_index !== undefined && ev.delta) {
          const slot = this.calls.get(ev.output_index);
          if (slot) slot.args += ev.delta;
        }
        return;
      case "response.completed":
        if (ev.response?.usage) this.usage = toUsage(ev.response.usage);
        return;
      case "response.incomplete":
        if (ev.response?.incomplete_details?.reason === "max_output_tokens") {
          if (ev.response.usage) this.usage = toUsage(ev.response.usage);
          this.truncated = true;
          return;
        }
        throw failure(ev.response?.error?.code, ev.response?.error?.message ?? ev.type);
      case "response.failed":
        throw failure(ev.response?.error?.code, ev.response?.error?.message ?? ev.type);
      case "error":
        throw failure(ev.code, ev.message ?? "error");
    }
  }

  /** tool names may arrive prefixed with the namespace; tools are registered by their bare names */
  private slot(item: OutputItem) {
    const name = item.name ?? "";
    const prefix = this.namespace ? `${this.namespace}.` : null;
    return { id: item.call_id ?? "", name: prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name, args: item.arguments ?? "", namespace: item.namespace };
  }

  response(): ChatResponse {
    const toolCalls = [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => {
        const call: ToolCall = { id: c.id || `call_${i}`, name: c.name, args: parseArgs(c.args) };
        if (c.namespace) call.meta = { namespace: c.namespace };
        return call;
      });
    const res: ChatResponse = { text: this.text, toolCalls, usage: this.usage };
    if (this.truncated) res.truncated = true;
    if (this.reasoning.trim()) res.reasoning = this.reasoning.trim();
    if (this.reasoningItems.length) res.meta = { reasoning: this.reasoningItems };
    return res;
  }
}
