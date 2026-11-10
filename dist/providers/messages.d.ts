import { type ChatRequest, type ChatResponse, type Message, type OnDelta, type SseEvent, type StreamParser } from "../core/types";
/** thinking blocks go back on the next turn exactly as received (the signature is verified) */
type ThinkingBlock = {
    type: "thinking";
    thinking: string;
    signature: string;
} | {
    type: "redacted_thinking";
    data: string;
};
type CacheControl = {
    type: "ephemeral";
};
type Block = ThinkingBlock | {
    type: "text";
    text: string;
    cache_control?: CacheControl;
} | {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
    cache_control?: CacheControl;
} | {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
    cache_control?: CacheControl;
} | {
    type: "tool_result";
    tool_use_id: string;
    content: string;
    is_error?: boolean;
    cache_control?: CacheControl;
};
interface WireMessage {
    role: "user" | "assistant";
    content: Block[];
}
/** strictly alternating roles: consecutive same-role turns merge; thinking blocks of earlier turns are replayed */
export declare function toAnthropicMessages(messages: Message[], thinking: boolean): WireMessage[];
export declare function messagesBody(req: ChatRequest): Record<string, unknown>;
export declare class MessagesStream implements StreamParser {
    private text;
    private reasoning;
    private usage?;
    private raw;
    private blocks;
    private order;
    private truncated;
    push({ event, data }: SseEvent, onDelta?: OnDelta): void;
    private open;
    private addUsage;
    response(): ChatResponse;
}
export {};
