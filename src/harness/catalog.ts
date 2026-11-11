import { toValue, type ComputedRef } from "vue";
import { planTool, readTool } from "../core/builtins";
import type { ResourceRef } from "../core/entries";
import type { NamespaceRegistry } from "../core/namespaces";
import { systemPrompt, type PromptSkill } from "../core/prompt";
import type { HarnessTool } from "../core/tools";
import { errorText } from "../core/types";
import type { Locale } from "../i18n";
import type { McpClient } from "../mcp/client";
import type { McpServers } from "../mcp/servers";
import { mcpHarnessTool } from "../mcp/tools";
import type { McpResource, McpResourceTemplate, McpTool } from "../mcp/types";
import type { AiOptions, AiState, PickerItem } from "./types";

export interface Catalog {
  tools(refresh?: boolean): Promise<HarnessTool[]>;
  forgetTools(): void;
  systemPrompt(): Promise<string>;
  pickerItems(query: string, signal: AbortSignal): Promise<PickerItem[]>;
}

interface Dependencies {
  servers: McpServers;
  namespaces: NamespaceRegistry;
  locale(): Locale;
  contextItems: ComputedRef<ResourceRef[]>;
}

const SKILL = /^skill:\/\//i;
const LIST_TIMEOUT_MS = 15000;

export function createCatalog(state: AiState, options: AiOptions, { servers, namespaces, locale, contextItems }: Dependencies): Catalog {
  let toolsPromise: Promise<HarnessTool[]> | null = null;
  const entries = Object.entries(servers.clients);

  async function serverTools(id: string, client: McpClient, refresh: boolean): Promise<McpTool[]> {
    const late = Promise.withResolvers<never>();
    const timer = setTimeout(() => late.reject(new Error("The server did not answer in time.")), LIST_TIMEOUT_MS);
    try {
      // a server that hangs must not hold the run: its tools are left out like those of a failing one
      const listing = (async () => [await client.connect(), await client.listTools({ refresh })] as const)();
      const [info, list] = await Promise.race([listing, late.promise]);
      state.mcp[id] = { name: servers.names[id] ?? id, info, error: "" };
      return list;
    } catch (e) {
      state.mcp[id] = { name: servers.names[id] ?? id, info: state.mcp[id]?.info ?? null, error: errorText(e) };
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  async function mcpTools(refresh: boolean): Promise<HarnessTool[]> {
    const lists = await Promise.all(entries.map(async ([id, client]) => ({ id, client, tools: await serverTools(id, client, refresh) })));
    const offered = new Map<string, number>();
    for (const { tools } of lists) for (const tool of tools) offered.set(tool.name, (offered.get(tool.name) ?? 0) + 1);
    return lists.flatMap(({ id, client, tools }) =>
      tools.map((tool) => mcpHarnessTool(tool, client, id, offered.get(tool.name)! > 1 ? `${id}__${tool.name}`.slice(0, 64) : tool.name)),
    );
  }

  async function fromServers<T>(list: (client: McpClient) => Promise<T[]>): Promise<T[]> {
    const lists = await Promise.all(entries.map(([id, client]) => (state.mcp[id]?.info?.capabilities.resources ? list(client).catch(() => [] as T[]) : [])));
    return lists.flat();
  }

  async function skills(): Promise<PromptSkill[]> {
    const resources = await fromServers<McpResource>((client) => client.listResources());
    const fromServer = resources
      .filter((r) => /^skill:\/\/.+\/SKILL\.md$/i.test(r.uri))
      .map((r) => ({ name: r.name || r.uri.replace(/^skill:\/\/|\/SKILL\.md$/gi, ""), description: r.description, uri: r.uri }));
    return [...fromServer, ...(options.skills ?? [])];
  }

  function serverInstructions(): string | undefined {
    const connected = entries.flatMap(([id]) => (state.mcp[id]?.info ? [[id, state.mcp[id]!.info!] as const] : []));
    if (entries.length === 1) return connected[0]?.[1].instructions;
    return connected.flatMap(([id, info]) => (info.instructions?.trim() ? [`## ${id}\n${info.instructions.trim()}`] : [])).join("\n\n") || undefined;
  }

  return {
    tools(refresh = false) {
      if (!toolsPromise || refresh || Object.values(state.mcp).some((s) => s.error)) {
        const builtins = [readTool(namespaces), planTool];
        const local = (options.tools ?? []).filter((tool) => !builtins.some((b) => b.name === tool.name));
        const taken = new Set([...builtins, ...local].map((tool) => tool.name));
        toolsPromise = mcpTools(refresh).then((list) => {
          const offered = [...list.filter((tool) => !taken.has(tool.name)), ...local];
          state.toolTitles = Object.fromEntries(offered.flatMap((tool) => (tool.title ? [[tool.name, tool.title]] : [])));
          return [...offered, ...builtins];
        });
      }
      return toolsPromise;
    },
    forgetTools() {
      toolsPromise = null;
    },
    async systemPrompt() {
      const templates = await fromServers<McpResourceTemplate>((client) => client.listResourceTemplates());
      const info = entries.length === 1 ? state.mcp[entries[0]![0]]?.info?.serverInfo : undefined;
      return systemPrompt({
        appName: options.name ?? info?.title ?? info?.name ?? "this app",
        serverInstructions: serverInstructions(),
        appInstructions: toValue(options.instructions),
        namespaces: [
          ...templates.map((tpl) => ({ template: tpl.uriTemplate, description: tpl.description ?? tpl.title })),
          ...namespaces.local().map((ns) => ({ template: ns.template, description: ns.description })),
        ],
        skills: await skills(),
        locale: locale(),
      });
    },
    async pickerItems(query, signal) {
      const q = query.trim().toLowerCase();
      const match = (r: { uri: string; label: string }) => !q || r.label.toLowerCase().includes(q) || r.uri.toLowerCase().includes(q);
      const out: PickerItem[] = contextItems.value.filter(match).map((r) => ({ ...r, group: "context" }));
      const [resources, found] = await Promise.all([
        Promise.allSettled(
          entries.map(async ([id, client]) => {
            const info = await client.connect();
            state.mcp[id] = { name: servers.names[id] ?? id, info, error: state.mcp[id]?.error ?? "" };
            return info.capabilities.resources ? client.listResources() : [];
          }),
        ).then((settled) => {
          const failed = settled.find((s) => s.status === "rejected");
          if (failed && settled.every((s) => s.status === "rejected")) throw failed.reason;
          return settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
        }),
        q && options.searchResources ? options.searchResources(q, signal) : [],
      ]);
      for (const r of resources) {
        const skill = SKILL.test(r.uri);
        const item: PickerItem = { uri: r.uri, label: r.title ?? r.name, description: r.description, group: skill ? "skills" : "resources", icon: skill ? "sparkles" : undefined };
        if (match(item) && !out.some((o) => o.uri === item.uri)) out.push(item);
      }
      for (const r of found) if (!out.some((o) => o.uri === r.uri)) out.push({ ...r, group: "results" });
      return out;
    },
  };
}
