import type { ChatTransport } from "../src/backend/types";

export interface FakeTurn {
  text?: string;
  reasoning?: string;
  calls?: { name: string; args: Record<string, unknown> }[];
  truncated?: boolean;
}

export interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: unknown;
  name?: string;
  call_id?: string;
  output?: string;
  arguments?: string;
}

let counter = 0;

export function responsesEvents(turn: FakeTurn): string {
  const events: object[] = [];
  let index = 0;
  if (turn.reasoning) {
    events.push({ type: "response.reasoning_summary_text.delta", delta: turn.reasoning });
    events.push({ type: "response.output_item.done", output_index: index++, item: { type: "reasoning", id: `rs_${++counter}`, summary: [], encrypted_content: "badger-secret" } });
  }
  if (turn.text) {
    for (const piece of turn.text.match(/[\s\S]{1,12}/g) ?? []) events.push({ type: "response.output_text.delta", delta: piece });
    index++;
  }
  for (const call of turn.calls ?? []) {
    const item = { type: "function_call", call_id: `call_${++counter}`, name: call.name, arguments: JSON.stringify(call.args) };
    events.push({ type: "response.output_item.added", output_index: index, item: { ...item, arguments: "" } });
    events.push({ type: "response.function_call_arguments.delta", output_index: index, delta: item.arguments });
    events.push({ type: "response.output_item.done", output_index: index, item });
    index++;
  }
  const usage = { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 80 } };
  events.push(turn.truncated ? { type: "response.incomplete", response: { usage, incomplete_details: { reason: "max_output_tokens" } } } : { type: "response.completed", response: { usage } });
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

export function sseResponse(body: string, delayMs = 0): Response {
  const encoder = new TextEncoder();
  const chunks = body.match(/[\s\S]{1,64}/g) ?? [];
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const c of chunks) {
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          controller.enqueue(encoder.encode(c));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

export function scriptedTransport(script: (input: ResponsesInputItem[], body: Record<string, unknown>) => FakeTurn, delayMs = 0): ChatTransport {
  return async ({ body }, signal) => {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    return sseResponse(responsesEvents(script(body.input as ResponsesInputItem[], body)), delayMs);
  };
}

export function toolOutputs(input: ResponsesInputItem[]): string[] {
  return input.filter((i) => i.type === "function_call_output").map((i) => i.output ?? "");
}

export function lastUser(input: ResponsesInputItem[]): string {
  const last = [...input].reverse().find((i) => i.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return Array.isArray(last.content) ? last.content.map((c: { text?: string }) => c.text ?? "").join("") : "";
}
