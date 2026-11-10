import { toValue, type ComputedRef } from "vue";
import { planTool, readTool } from "../core/builtins";
import type { ResourceRef } from "../core/entries";
import type { NamespaceRegistry } from "../core/namespaces";
import { systemPrompt, type PromptSkill } from "../core/prompt";
import type { HarnessTool } from "../core/tools";
import { errorText } from "../core/types";
import type { Locale } from "../i18n";
import type { McpClient } from "../mcp/client";
import { mcpHarnessTool } from "../mcp/tools";
import type { McpResource } from "../mcp/types";
import type { AiOptions, AiState, PickerItem } from "./types";

export interface Catalog {
  tools(refresh?: boolean): Promise<HarnessTool[]>;
  forgetTools(): void;
  systemPrompt(): Promise<string>;
  pickerItems(query: string, signal: AbortSignal): Promise<PickerItem[]>;
}

interface Dependencies {
  mcp: McpClient | null;
  namespaces: NamespaceRegistry;
  locale(): Locale;
  contextItems: ComputedRef<ResourceRef[]>;
}

const SKILL = /^skill:\/\//i;

export function createCatalog(state: AiState, options: AiOptions, { mcp, namespaces, locale, contextItems }: Dependencies): Catalog {
  let toolsPromise: Promise<HarnessTool[]> | null = null;

  async function mcpTools(refresh: boolean): Promise<HarnessTool[]> {
    if (!mcp) return [];
    try {
      state.mcpInfo = await mcp.connect();
      const list = await mcp.listTools({ refresh });
      state.mcpError = "";
      return list.map((tool) => mcpHarnessTool(tool, mcp));
    } catch (e) {
      state.mcpError = errorText(e);
      return [];
    }
  }

  async function skills(): Promise<PromptSkill[]> {
    const local = options.skills ?? [];
    if (!mcp || !state.mcpInfo?.capabilities.resources) return local;
    const resources = await mcp.listResources().catch(() => [] as McpResource[]);
    const fromServer = resources
      .filter((r) => /^skill:\/\/.+\/SKILL\.md$/i.test(r.uri))
      .map((r) => ({ name: r.name || r.uri.replace(/^skill:\/\/|\/SKILL\.md$/gi, ""), description: r.description, uri: r.uri }));
    return [...fromServer, ...local];
  }

  return {
    tools(refresh = false) {
      if (!toolsPromise || refresh || state.mcpError) {
        const builtins = [readTool(namespaces), planTool];
        toolsPromise = mcpTools(refresh).then((list) => {
          state.toolTitles = Object.fromEntries(list.flatMap((tool) => (tool.title ? [[tool.name, tool.title]] : [])));
          return [...list.filter((tool) => !builtins.some((b) => b.name === tool.name)), ...builtins];
        });
      }
      return toolsPromise;
    },
    forgetTools() {
      toolsPromise = null;
    },
    async systemPrompt() {
      const templates = mcp && state.mcpInfo?.capabilities.resources ? await mcp.listResourceTemplates().catch(() => []) : [];
      const info = state.mcpInfo?.serverInfo;
      return systemPrompt({
        appName: options.name ?? info?.title ?? info?.name ?? "this app",
        serverInstructions: state.mcpInfo?.instructions,
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
        mcp
          ? mcp.connect().then((info) => {
              state.mcpInfo = info;
              return info.capabilities.resources ? mcp.listResources() : [];
            })
          : [],
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
