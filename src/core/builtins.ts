import type { NamespaceRegistry, ReadResult } from "./namespaces";
import { READ_LIMIT } from "./namespaces";
import { normalizePlan, parseSteps, PLAN_STATUSES, PLAN_TOOL, planText } from "./plan";
import { READ_TOOL } from "./pruning";
import type { HarnessTool } from "./tools";

export function formatRead(r: ReadResult): string {
  const head = [`${r.uri}${r.name ? ` (${r.name})` : ""}${r.mimeType ? ` [${r.mimeType}]` : ""}`];
  if (r.pages) head.push(`Page ${r.page ?? 1} of ${r.pages}.${(r.page ?? 1) < r.pages ? ` Read page=${(r.page ?? 1) + 1} for the next page.` : ""}`);
  const parts = [head.join("\n")];
  if (r.text !== undefined) parts.push(r.text || "(empty)");
  if (r.image) parts.push(`[Image ${r.image.uri}${r.image.page ? ` page ${r.image.page}` : ""}, shown below as visual input.]`);
  if (r.nextOffset !== undefined) {
    parts.push(`[Characters ${r.offset}-${r.nextOffset} of ${r.totalChars}. Continue with offset=${r.nextOffset}.]`);
  } else if (r.offset > 0) parts.push(`[Characters ${r.offset}-${r.totalChars} of ${r.totalChars}. End of text.]`);
  return parts.join("\n\n");
}

export function readTool(registry: NamespaceRegistry): HarnessTool {
  return {
    name: READ_TOOL,
    title: "Read",
    description: `Read a resource by URI: chat attachments (attachment://), skills (skill://.../SKILL.md) and every namespace listed in the system prompt. Text comes in chunks of at most ${READ_LIMIT} characters: when the result says so, continue with offset. Images and PDF pages come back as visual input; use page for later PDF pages.`,
    parameters: {
      type: "object",
      properties: {
        uri: { type: "string", description: "Resource URI, e.g. attachment://<id> or a URI from a namespace template." },
        offset: { type: "integer", minimum: 0, description: "Character offset to start from (the next offset of the previous chunk)." },
        limit: { type: "integer", minimum: 1, maximum: READ_LIMIT, description: `Maximum characters to return (default ${READ_LIMIT}).` },
        page: { type: "integer", minimum: 1, description: "PDF page (default 1)." },
      },
      required: ["uri"],
      additionalProperties: false,
    },
    approval: "auto",
    readOnly: true,
    keep: (args) => typeof args.uri === "string" && args.uri.startsWith("skill://"),
    async run(args, ctx) {
      const r = await registry.read(String(args.uri), { offset: args.offset as number | undefined, limit: args.limit as number | undefined, page: args.page as number | undefined, signal: ctx.signal });
      return { text: formatRead(r), images: r.image ? [r.image] : undefined };
    },
  };
}

export const planTool: HarnessTool = {
  name: PLAN_TOOL,
  title: "Plan",
  description:
    "Keep a short checklist for a task with several steps. Send the whole list each time: one step active, the rest pending, done or dropped. The user sees it. Skip it for simple tasks.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            text: { type: "string", description: "What the step does, a few words." },
            status: { type: "string", enum: [...PLAN_STATUSES] },
          },
          required: ["text", "status"],
        },
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
  approval: "auto",
  readOnly: false,
  keep: () => true,
  async run(args) {
    const steps = parseSteps(args.steps);
    if (!steps) return { text: "steps must be a list of {text, status} items.", isError: true };
    return { text: planText(normalizePlan(steps)) };
  },
};
