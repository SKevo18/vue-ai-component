import type { AiBackend, AiConnection } from "./types";
/** the providers of the Go package `github.com/SKevo18/vue-ai-component/go/aiserver` */
export type ServerProviderId = "chatgpt" | "codex" | "claude" | "antigravity" | "openai" | "anthropic" | "gemini";
/** one provider's entry of `GET status` */
export interface ServerProviderStatus {
    kind: "oauth" | "key";
    enabled: boolean;
    connected: boolean;
    email?: string;
    account_id?: string;
    expires_at?: string;
    /** false when the credential was sealed with another browser's key */
    key_match?: boolean;
}
type Overrides = Partial<Omit<AiConnection, "id" | "kind" | "connected" | "enabled">> & {
    /** shown in the paste step of a sign-in */
    hint?: string;
};
/** a provider id, or one with overrides of its default name, links and texts */
export type ServerProvider = ServerProviderId | ({
    id: ServerProviderId;
} & Overrides);
export interface ServerBackendOptions {
    /** where the aiserver handler is mounted, for example `/api/ai` */
    baseUrl: string;
    fetch?: typeof fetch;
    /** extra headers of every request, for example a browser key the server seals credentials with */
    headers?: HeadersInit | (() => HeadersInit);
    /** the listed providers in this order, default every provider the server enables, sign-ins first */
    providers?: ServerProvider[];
    /** user-facing text for an error code, default the server's message */
    message?: (code: string, fallback: string) => string;
    /** adjusts each listed connection, for example with a note when `key_match` is false */
    connection?: (connection: AiConnection, status: ServerProviderStatus) => AiConnection;
}
/**
 * The backend of a server running the aiserver handler: subscription sign-ins and server-stored API keys with the
 * server's chat proxy. Merge it with createBrowserKeys to offer browser-held keys next to the sign-ins.
 */
export declare function createServerBackend(options: ServerBackendOptions): AiBackend;
export {};
