import { parseJson } from "../core/sse";
import { AiError, type ChatRequest, type ChatResponse, type JsonSchema, type Message, type OnDelta, type SseEvent, type StreamParser, type ToolCall, type Usage } from "../core/types";

type Part =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args?: Record<string, unknown> }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface Content {
  role: "user" | "model";
  parts: Part[];
}

interface Chunk {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; cachedContentTokenCount?: number };
  error?: { message?: string; status?: string };
  /** some proxies wrap each chunk */
  response?: Chunk;
}

const THINKING_MODELS = /gemini-(2\.5|[3-9])/;

export function toGeminiContents(messages: Message[]): Content[] {
  const out: Content[] = [];
  const push = (role: Content["role"], parts: Part[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ text: m.content || " " }, ...(m.images ?? []).map((i): Part => ({ inlineData: { mimeType: i.mimeType, data: i.data } }))]);
    else if (m.role === "assistant") {
      const parts: Part[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.toolCalls) {
        const p: Part = { functionCall: { name: c.name, args: c.args } };
        if (typeof c.meta?.thoughtSignature === "string") p.thoughtSignature = c.meta.thoughtSignature;
        parts.push(p);
      }
      if (parts.length) push("model", parts);
    } else {
      const parsed = parseJson<unknown>(m.content);
      const response = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { result: m.content };
      push("user", [{ functionResponse: { name: m.name, response: m.isError ? { error: m.content } : response } }]);
    }
  }
  return out;
}

/**
 * the Gemini API takes an OpenAPI subset: one type per schema, enums only on strings, and a free-form object (no properties)
 * travels as JSON text that the harness parses back.
 */
export function toGeminiSchema(s: JsonSchema): Record<string, unknown> {
  const variants = s.anyOf ?? s.oneOf;
  if (variants?.length) {
    const real = variants.filter((v) => v.type !== "null");
    const picked = toGeminiSchema({ ...real[0], description: real[0]?.description ?? s.description });
    return real.length < variants.length ? { ...picked, nullable: true } : picked;
  }
  const types = (Array.isArray(s.type) ? s.type : s.type ? [s.type] : ["object"]).filter((t) => t !== "null");
  const type = types[0] ?? "string";
  const nullable = Array.isArray(s.type) && s.type.includes("null");
  if (type === "object" && !s.properties) return { type: "STRING", description: `${s.description ?? ""} (JSON object text)`.trim(), ...(nullable ? { nullable } : {}) };
  const out: Record<string, unknown> = { type: type.toUpperCase() };
  if (nullable) out.nullable = true;
  if (s.description) out.description = s.description;
  if (s.enum && type === "string") out.enum = s.enum.map(String);
  if (s.items) out.items = toGeminiSchema(s.items);
  else if (type === "array") out.items = { type: "STRING" };
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    if (s.required?.length) out.required = s.required;
  }
  if (s.minimum !== undefined) out.minimum = s.minimum;
  if (s.maximum !== undefined) out.maximum = s.maximum;
  return out;
}

export function generateBody(req: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    systemInstruction: { parts: [{ text: req.system }] },
    contents: toGeminiContents(req.messages),
  };
  if (THINKING_MODELS.test(req.model)) body.generationConfig = { thinkingConfig: { includeThoughts: true } };
  if (req.tools.length) body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema({ ...t.parameters, type: "object" }) })) }];
  return body;
}

export class GenerateStream implements StreamParser {
  private text = "";
  private reasoning = "";
  private usage?: Usage;
  private readonly stamp = Date.now().toString(36);
  private calls: ToolCall[] = [];
  private truncated = false;

  push({ data }: SseEvent, onDelta?: OnDelta): void {
    const raw = parseJson<Chunk>(data);
    if (!raw) return;
    const chunk = raw.response ?? raw;
    if (chunk.error?.message) throw new AiError(chunk.error.status === "RESOURCE_EXHAUSTED" ? "rate_limit" : "server", chunk.error.message, undefined, chunk.error.status);
    if (chunk.usageMetadata) {
      const u = chunk.usageMetadata;
      this.usage = { input: u.promptTokenCount ?? 0, output: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
      if (u.cachedContentTokenCount) this.usage.cached = u.cachedContentTokenCount;
    }
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason === "MAX_TOKENS") this.truncated = true;
    for (const part of candidate?.content?.parts ?? []) {
      if ("text" in part && part.text) {
        if (part.thought) {
          this.reasoning += part.text;
          onDelta?.(part.text, "reasoning");
        } else {
          this.text += part.text;
          onDelta?.(part.text, "text");
        }
      } else if ("functionCall" in part) {
        const call: ToolCall = { id: `call_${this.stamp}_${this.calls.length + 1}`, name: part.functionCall.name, args: part.functionCall.args ?? {} };
        if (part.thoughtSignature) call.meta = { thoughtSignature: part.thoughtSignature };
        this.calls.push(call);
      }
    }
  }

  response(): ChatResponse {
    const res: ChatResponse = { text: this.text, toolCalls: this.calls, usage: this.usage };
    if (this.truncated) res.truncated = true;
    if (this.reasoning) res.reasoning = this.reasoning;
    return res;
  }
}
