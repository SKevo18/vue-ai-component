import type { Approval, ImageRef, ResourceLink } from "../core/entries";
import { parseApprovalPreview } from "../core/approval";
import { clipResult, type HarnessTool, type ToolContext, type ToolResult } from "../core/tools";
import type { McpClient, McpProgress } from "./client";
import type { McpTool, McpToolResult } from "./types";

const APPROVALS: Record<string, Approval> = { auto: "auto", ask: "ask", confirm: "confirm" };

/**
 * from `_meta.approval` when the server sets it, else from the annotations: read-only runs without asking unless it
 * reaches the outside world, open-world or destructive asks for confirmation, anything else asks.
 */
export function toolApproval(tool: McpTool): Approval {
  const declared = tool._meta?.approval;
  if (typeof declared === "string" && APPROVALS[declared]) return APPROVALS[declared];
  const a = tool.annotations ?? {};
  if (a.readOnlyHint === true) return a.openWorldHint === true ? "ask" : "auto";
  if (a.openWorldHint === true || a.destructiveHint === true) return "confirm";
  return "ask";
}

export async function toolResult(result: McpToolResult, ctx: Pick<ToolContext, "saveImage">): Promise<ToolResult> {
  const texts: string[] = [];
  const images: ImageRef[] = [];
  const links: ResourceLink[] = [];
  for (const item of result.content) {
    switch (item.type) {
      case "text":
        texts.push(item.text);
        break;
      case "image": {
        const ref = await ctx.saveImage({ mimeType: item.mimeType, data: item.data });
        images.push(ref);
        texts.push(`[Image ${ref.uri}, shown below as visual input.]`);
        break;
      }
      case "resource_link":
        links.push({ uri: item.uri, name: item.name, title: item.title, mimeType: item.mimeType });
        texts.push(`[Resource ${item.uri}${item.title || item.name ? ` (${item.title || item.name})` : ""}${item.description ? `: ${item.description}` : ""}. Read it with read if you need its content.]`);
        break;
      case "resource": {
        const r = item.resource;
        if ("text" in r) texts.push(`[Resource ${r.uri}]\n${r.text}`);
        else if (r.mimeType?.startsWith("image/")) {
          const ref = await ctx.saveImage({ mimeType: r.mimeType, data: r.blob });
          images.push(ref);
          texts.push(`[Image ${r.uri} as ${ref.uri}, shown below as visual input.]`);
        } else texts.push(`[Binary resource ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ""} is not shown.]`);
        break;
      }
      case "audio":
        texts.push(`[Audio (${item.mimeType}) is not supported here.]`);
        break;
    }
  }
  if (!texts.length && result.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent));
  const hint = links.length ? `Read ${links[0]!.uri} for the full content.` : "";
  return {
    text: clipResult(texts.join("\n\n") || (result.isError ? "The tool failed without a message." : "Done."), hint),
    isError: result.isError === true || undefined,
    images: images.length ? images : undefined,
    links: links.length ? links : undefined,
  };
}

export function mcpHarnessTool(tool: McpTool, client: McpClient): HarnessTool {
  const approval = toolApproval(tool);
  return {
    name: tool.name,
    title: tool.title ?? tool.annotations?.title,
    description: tool.description ?? tool.title ?? tool.name,
    parameters: { ...tool.inputSchema, type: "object" },
    approval,
    approvalPreview: parseApprovalPreview(tool._meta?.approvalPreview),
    readOnly: tool.annotations?.readOnlyHint === true,
    async run(args, ctx) {
      const onProgress = (p: McpProgress) => ctx.onProgress?.(p.message ?? (p.total ? `${p.progress}/${p.total}` : String(p.progress)));
      return toolResult(await client.callTool(tool.name, args, { signal: ctx.signal, onProgress }), ctx);
    },
  };
}
