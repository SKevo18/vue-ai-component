export type Dialect = "responses" | "messages" | "generate";
export interface ToolCall {
    id: string;
    name: string;
    args: Record<string, unknown>;
    /** provider extras that must round-trip (Gemini thought signatures, Responses namespaces) */
    meta?: Record<string, unknown>;
}
export interface ImageContent {
    mimeType: string;
    data: string;
}
export type Message = {
    role: "user";
    content: string;
    images?: ImageContent[];
} | {
    role: "assistant";
    content: string;
    toolCalls: ToolCall[];
    meta?: Record<string, unknown>;
} | {
    role: "tool";
    toolCallId: string;
    name: string;
    content: string;
    isError?: boolean;
};
export type DeltaKind = "text" | "reasoning";
export type OnDelta = (text: string, kind: DeltaKind) => void;
export interface JsonSchema {
    type?: string | string[];
    description?: string;
    properties?: Record<string, JsonSchema>;
    required?: string[];
    items?: JsonSchema;
    enum?: unknown[];
    anyOf?: JsonSchema[];
    oneOf?: JsonSchema[];
    minimum?: number;
    maximum?: number;
    minLength?: number;
    additionalProperties?: boolean | JsonSchema;
    [key: string]: unknown;
}
export interface ToolSpec {
    name: string;
    description: string;
    parameters: JsonSchema;
}
export interface Usage {
    /** all prompt tokens: uncached, cache writes and cache reads */
    input: number;
    output: number;
    cached?: number;
}
export interface ChatRequest {
    model: string;
    system: string;
    messages: Message[];
    tools: ToolSpec[];
    cacheKey?: string;
}
export interface ChatResponse {
    text: string;
    toolCalls: ToolCall[];
    usage?: Usage;
    reasoning?: string;
    /** provider blocks replayed unchanged on the next turn (thinking signatures, encrypted reasoning) */
    meta?: Record<string, unknown>;
    truncated?: boolean;
}
export interface SseEvent {
    event: string;
    data: string;
}
export interface StreamParser {
    push(ev: SseEvent, onDelta?: OnDelta): void;
    response(): ChatResponse;
}
export type ChatFn = (req: ChatRequest, onDelta?: OnDelta, signal?: AbortSignal) => Promise<ChatResponse>;
export type AiErrorKind = "auth" | "rate_limit" | "network" | "aborted" | "bad_request" | "server" | "unknown";
export declare class AiError extends Error {
    kind: AiErrorKind;
    status?: number;
    code?: string;
    constructor(kind: AiErrorKind, message: string, status?: number, code?: string);
}
export declare function errorText(e: unknown): string;
