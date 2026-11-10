import type { AiConnection, ChatTransport } from "../backend/types";
import { parseStream, send } from "../core/sse";
import type { ChatFn, ChatRequest, Dialect, StreamParser } from "../core/types";
import { GenerateStream, generateBody } from "./generate";
import { MessagesStream, messagesBody } from "./messages";
import { ResponsesStream, responsesBody, type ResponsesOptions } from "./responses";

export function nativeBody(dialect: Dialect, req: ChatRequest, options: ResponsesOptions = {}): Record<string, unknown> {
  if (dialect === "responses") return responsesBody(req, options);
  if (dialect === "messages") return messagesBody(req);
  return generateBody(req);
}

export function streamParser(dialect: Dialect, options: ResponsesOptions = {}): StreamParser {
  if (dialect === "responses") return new ResponsesStream(options.toolNamespace);
  if (dialect === "messages") return new MessagesStream();
  return new GenerateStream();
}

export function connectionChat(connection: Pick<AiConnection, "dialect" | "wire">, transport: ChatTransport): ChatFn {
  const options: ResponsesOptions = connection.wire ?? {};
  return async (req, onDelta, signal) => {
    const body = nativeBody(connection.dialect, req, options);
    const res = await send(() => transport({ dialect: connection.dialect, model: req.model, body }, signal), signal);
    return parseStream(res, streamParser(connection.dialect, options), onDelta, signal);
  };
}
