import { AiError, type ChatResponse, type OnDelta, type SseEvent, type StreamParser } from "./types";
export declare class SseParser {
    private buffer;
    private event;
    private data;
    push(chunk: string): SseEvent[];
    end(): SseEvent[];
}
export declare function readSse(res: Response, signal?: AbortSignal): AsyncGenerator<SseEvent>;
export declare function parseStream(res: Response, parser: StreamParser, onDelta?: OnDelta, signal?: AbortSignal): Promise<ChatResponse>;
export declare function send(request: () => Promise<Response>, signal?: AbortSignal): Promise<Response>;
export declare function toAiError(status: number, body: string): AiError;
export declare function parseJson<T>(data: string): T | null;
export declare function parseArgs(json: string): Record<string, unknown>;
