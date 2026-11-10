import { type ChatRequest, type ChatResponse, type Message, type OnDelta, type SseEvent, type StreamParser } from "../core/types";
export interface ResponsesOptions {
    toolNamespace?: string;
    reasoning?: boolean;
}
type InputItem = {
    role: "user";
    content: string | ({
        type: "input_text";
        text: string;
    } | {
        type: "input_image";
        image_url: string;
        detail: "auto";
    })[];
} | {
    type: "message";
    role: "assistant";
    content: {
        type: "output_text";
        text: string;
    }[];
} | {
    type: "function_call";
    call_id: string;
    name: string;
    arguments: string;
    namespace?: string;
} | {
    type: "function_call_output";
    call_id: string;
    output: string;
} | ReasoningItem;
interface ReasoningItem {
    type: "reasoning";
    id: string;
    summary: unknown[];
    encrypted_content?: string;
}
export declare function toResponsesInput(messages: Message[]): InputItem[];
export declare function responsesBody(req: ChatRequest, options?: ResponsesOptions): Record<string, unknown>;
export declare class ResponsesStream implements StreamParser {
    private readonly namespace?;
    private text;
    private reasoning;
    private usage?;
    private reasoningItems;
    private truncated;
    private calls;
    constructor(namespace?: string | undefined);
    push({ data }: SseEvent, onDelta?: OnDelta): void;
    /** tool names may arrive prefixed with the namespace; tools are registered by their bare names */
    private slot;
    response(): ChatResponse;
}
export {};
