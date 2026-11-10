import type { Dialect, ToolCall, Usage } from "./types";
export type ToolStatus = "pending" | "awaiting" | "running" | "done" | "error" | "rejected";
export type Approval = "auto" | "ask" | "confirm";
export interface ResourceRef {
    uri: string;
    label: string;
    icon?: string;
    /** original file size in bytes, when known */
    size?: number;
}
export interface ImageRef {
    uri: string;
    page?: number;
}
export interface ResourceLink {
    uri: string;
    name?: string;
    title?: string;
    mimeType?: string;
}
export type UserEntry = {
    id: string;
    role: "user";
    content: string;
    resources?: ResourceRef[];
};
export type AssistantEntry = {
    id: string;
    role: "assistant";
    content: string;
    toolCalls: ToolCall[];
    usage?: Usage;
    streaming?: boolean;
    reasoning?: string;
    meta?: Record<string, unknown>;
    /** wire format that produced `meta`; provider blocks are replayed only to the same format */
    dialect?: Dialect;
};
export type ToolEntry = {
    id: string;
    role: "tool";
    toolCallId: string;
    name: string;
    args: Record<string, unknown>;
    content: string;
    isError?: boolean;
    status: ToolStatus;
    images?: ImageRef[];
    links?: ResourceLink[];
    elided?: boolean;
};
export type ReminderEntry = {
    id: string;
    role: "reminder";
    content: string;
};
export type Entry = UserEntry | AssistantEntry | ToolEntry | ReminderEntry;
