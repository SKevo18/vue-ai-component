import type { AiConnection, ChatTransport } from "../backend/types";
import type { ChatFn, ChatRequest, Dialect, StreamParser } from "../core/types";
import { type ResponsesOptions } from "./responses";
export declare function nativeBody(dialect: Dialect, req: ChatRequest, options?: ResponsesOptions): Record<string, unknown>;
export declare function streamParser(dialect: Dialect, options?: ResponsesOptions): StreamParser;
export declare function connectionChat(connection: Pick<AiConnection, "dialect" | "wire">, transport: ChatTransport): ChatFn;
