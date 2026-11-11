import { schemeOf } from "../core/namespaces";
import { createMcpClient, type McpClient, type McpClientOptions, type McpRequestOptions } from "./client";
import type { McpResourceContents, McpServerInfo } from "./types";

/** `name` is what notices call the server, by default its id */
export type McpServerConfig = (McpClient | McpClientOptions) & { name?: string };

export interface McpServerState {
  name: string;
  info: McpServerInfo | null;
  error: string;
}

export interface McpServerFailure {
  id: string;
  name: string;
  /** the raw error, for a tooltip */
  error: string;
}

export interface McpServers {
  readonly clients: Readonly<Record<string, McpClient>>;
  readonly names: Readonly<Record<string, string>>;
  readResource(uri: string, options?: McpRequestOptions): Promise<McpResourceContents[]>;
}

const SERVER_ID = /^[A-Za-z0-9_-]{1,32}$/;

function sameOrigin(url: string): boolean {
  if (typeof location === "undefined") return true;
  try {
    return new URL(url, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

// the tab header goes only to same-origin servers: other origins would need it allowed in their CORS preflight
export function createMcpServers(config: Readonly<Record<string, McpServerConfig>> | undefined, tabHeaders?: () => Record<string, string>): McpServers {
  const clients: Record<string, McpClient> = {};
  const names: Record<string, string> = {};
  for (const [id, entry] of Object.entries(config ?? {})) {
    if (!SERVER_ID.test(id)) throw new Error(`MCP server id "${id}" must be 1-32 letters, digits, "_" or "-".`);
    names[id] = entry.name?.trim() || id;
    clients[id] = "callTool" in entry
      ? entry
      : createMcpClient({
          ...entry,
          headers: async () => ({ ...(tabHeaders && sameOrigin(entry.url) ? tabHeaders() : {}), ...((await entry.headers?.()) ?? {}) }),
        });
  }
  const list = Object.values(clients);

  async function serves(client: McpClient, scheme: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const info = await client.connect({ signal });
      if (!info.capabilities.resources) return false;
      const [templates, resources] = await Promise.all([client.listResourceTemplates({ signal }), client.listResources({ signal })]);
      return [...templates.map((t) => t.uriTemplate), ...resources.map((r) => r.uri)].some((uri) => schemeOf(uri) === scheme);
    } catch {
      return false;
    }
  }

  return {
    clients,
    names,
    async readResource(uri, options) {
      if (!list.length) throw new Error(`No namespace serves ${uri}.`);
      if (list.length === 1) return list[0]!.readResource(uri, options);
      const scheme = schemeOf(uri) ?? "";
      const advertised = await Promise.all(list.map((client) => serves(client, scheme, options?.signal)));
      const ordered = [...list.filter((_, i) => advertised[i]), ...list.filter((_, i) => !advertised[i])];
      let failure: unknown;
      for (const client of ordered) {
        try {
          return await client.readResource(uri, options);
        } catch (e) {
          if (options?.signal?.aborted) throw e;
          failure ??= e;
        }
      }
      throw failure;
    },
  };
}

export function failedServers(servers: Readonly<Record<string, McpServerState>>): McpServerFailure[] {
  return Object.entries(servers).flatMap(([id, s]) => (s.error ? [{ id, name: s.name, error: s.error }] : []));
}

/** identifies a set of failures, so a closed notice stays closed until they change */
export function failuresKey(failures: readonly McpServerFailure[]): string {
  return JSON.stringify(failures.map((f) => [f.id, f.error]));
}
