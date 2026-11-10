import { AiError, type ChatResponse, type OnDelta, type SseEvent, type StreamParser } from "./types";

export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.data.length) out.push({ event: this.event, data: this.data.join("\n") });
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
    }
    return out;
  }

  end(): SseEvent[] {
    return this.push("\n\n");
  }
}

export async function* readSse(res: Response, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  try {
    for (;;) {
      if (signal?.aborted) throw new AiError("aborted", "aborted");
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (signal?.aborted || (e as Error)?.name === "AbortError") throw new AiError("aborted", "aborted");
        throw new AiError("network", (e as Error)?.message || "network error");
      }
      if (chunk.done) break;
      for (const ev of parser.push(decoder.decode(chunk.value, { stream: true }))) yield ev;
    }
    for (const ev of parser.end()) yield ev;
  } finally {
    reader.releaseLock();
  }
}

export async function parseStream(res: Response, parser: StreamParser, onDelta?: OnDelta, signal?: AbortSignal): Promise<ChatResponse> {
  for await (const ev of readSse(res, signal)) parser.push(ev, onDelta);
  return parser.response();
}

export async function send(request: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await request();
  } catch (e) {
    if (e instanceof AiError) throw e;
    if ((e as Error)?.name === "AbortError" || signal?.aborted) throw new AiError("aborted", "aborted");
    throw new AiError("network", (e as Error)?.message || "network error");
  }
  if (res.ok) return res;
  throw toAiError(res.status, await res.text().catch(() => ""));
}

const AUTH_CODES: Record<string, true> = { not_connected: true, oauth_expired: true, invalid_key: true, unauthorized: true, invalid_api_key: true };

export function toAiError(status: number, body: string): AiError {
  let message = "";
  let code: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; code?: string | number; type?: string; status?: string } | string; message?: string };
    if (typeof parsed.error === "string") message = parsed.error;
    else {
      message = parsed.error?.message ?? parsed.message ?? "";
      const c = parsed.error?.code ?? parsed.error?.type ?? parsed.error?.status;
      if (c !== undefined) code = String(c);
    }
  } catch {
    message = body.slice(0, 300);
  }
  message = message || `HTTP ${status}`;
  if (status === 401 || status === 403 || (code && AUTH_CODES[code])) return new AiError("auth", message, status, code);
  if (status === 429) return new AiError("rate_limit", message, status, code);
  if (status === 400 && /api key|unauthenticated|credential/i.test(message)) return new AiError("auth", message, status, code);
  if (status >= 500) return new AiError("server", message, status, code);
  if (status >= 400) return new AiError("bad_request", message, status, code);
  return new AiError("unknown", message, status, code);
}

export function parseJson<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export function parseArgs(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  const v = parseJson<unknown>(json);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { _raw: json };
}
