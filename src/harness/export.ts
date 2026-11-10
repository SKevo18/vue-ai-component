import type { ResourceRef } from "../core/entries";
import { toolSpecs } from "../core/tools";
import { errorText } from "../core/types";
import type { StoredConversation } from "../stores/conversations";
import type { Catalog } from "./catalog";
import type { AiState } from "./types";

interface ExportInput {
  state: AiState;
  stored: StoredConversation;
  current: boolean;
  catalog: Catalog;
  connection: string | null;
  model: string | null;
  context: ResourceRef[];
}

export async function conversationExport({ state, stored, current, catalog, connection, model, context }: ExportInput): Promise<{ filename: string; json: string }> {
  let system: string | null = null;
  let systemError: string | undefined;
  let specs: unknown = [];
  try {
    specs = toolSpecs(await catalog.tools());
    system = await catalog.systemPrompt();
  } catch (e) {
    systemError = errorText(e);
  }
  const exportedAt = new Date().toISOString();
  const data = {
    format: "vue-ai-component-conversation",
    version: 1,
    exported_at: exportedAt,
    site: typeof location === "undefined" ? undefined : location.origin,
    conversation: {
      id: stored.id,
      title: stored.title,
      connection: stored.connection ?? connection,
      model: stored.model ?? model,
      running: current && state.running,
      activity: current && state.running ? state.activity : null,
      error: current ? state.error : null,
      allowed_tools: stored.allowedTools ?? [],
      auto_approve: stored.autoApprove ?? false,
    },
    mcp: state.mcpInfo ? { server: state.mcpInfo.serverInfo, protocol: state.mcpInfo.protocolVersion, error: state.mcpError || undefined } : { error: state.mcpError || undefined },
    system,
    ...(systemError ? { system_error: systemError } : {}),
    tools: specs,
    resources: { attached: stored.attached ?? [], context: current ? context : [] },
    entries: stored.entries,
  };
  const stamp = exportedAt.slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return { filename: `ai-conversation-${stamp}-${stored.id.slice(0, 8)}.json`, json: JSON.stringify(data, null, 2) };
}
