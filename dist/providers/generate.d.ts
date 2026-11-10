import { type ChatRequest, type ChatResponse, type JsonSchema, type Message, type OnDelta, type SseEvent, type StreamParser } from "../core/types";
type Part = {
    text: string;
    thought?: boolean;
    thoughtSignature?: string;
} | {
    inlineData: {
        mimeType: string;
        data: string;
    };
} | {
    functionCall: {
        name: string;
        args?: Record<string, unknown>;
    };
    thoughtSignature?: string;
} | {
    functionResponse: {
        name: string;
        response: Record<string, unknown>;
    };
};
interface Content {
    role: "user" | "model";
    parts: Part[];
}
export declare function toGeminiContents(messages: Message[]): Content[];
/**
 * the Gemini API takes an OpenAPI subset: one type per schema, enums only on strings, and a free-form object (no properties)
 * travels as JSON text that the harness parses back.
 */
export declare function toGeminiSchema(s: JsonSchema): Record<string, unknown>;
export declare function generateBody(req: ChatRequest): Record<string, unknown>;
export declare class GenerateStream implements StreamParser {
    private text;
    private reasoning;
    private usage?;
    private readonly stamp;
    private calls;
    private truncated;
    push({ data }: SseEvent, onDelta?: OnDelta): void;
    response(): ChatResponse;
}
export {};
