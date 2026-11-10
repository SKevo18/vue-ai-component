// every change to an older message makes the provider read everything after it again at full price instead of from
// its prompt cache, so old results are elided rarely and in large batches, and an elided result stays elided. A read
// of a resource that a later write changed is marked outdated, so the model never edits from stale text.
import type { Entry, ToolEntry } from "./entries";
import { PLAN_TOOL } from "./plan";
import type { HarnessTool } from "./tools";

/** tool output (characters) that stays whole after a batch: the newest results */
export const KEEP_CHARS = 120_000;
export const ELIDE_AT = 320_000;
/** results up to this length are never elided: the note replacing them would save next to nothing */
const LARGE_RESULT = 2_000;

export const READ_TOOL = "read";

function target(e: ToolEntry): string | null {
  return typeof e.args.uri === "string" ? e.args.uri.replace(/#.*$/, "") : null;
}

function kept(e: ToolEntry, tools: Map<string, HarnessTool>): boolean {
  return e.isError === true || e.name === PLAN_TOOL || tools.get(e.name)?.keep?.(e.args) === true;
}

function doneTools(entries: Entry[]): ToolEntry[] {
  return entries.filter((e): e is ToolEntry => e.role === "tool" && e.status === "done");
}

function outdatedReads(done: ToolEntry[], tools: Map<string, HarnessTool>): Map<string, string> {
  const out = new Map<string, string>();
  const laterChange = new Set<string>();
  for (let i = done.length - 1; i >= 0; i--) {
    const e = done[i]!;
    const t = target(e);
    if (!t || kept(e, tools)) continue;
    if (e.name === READ_TOOL) {
      if (laterChange.has(t)) out.set(e.id, `[Outdated: ${t} was changed afterwards. Read it again if you need it.]`);
    } else if (tools.get(e.name)?.readOnly === false) laterChange.add(t);
  }
  return out;
}

function elisionNote(e: ToolEntry): string {
  const a = e.args;
  let what = e.name;
  if (typeof a.uri === "string") what += ` ${a.uri}${typeof a.offset === "number" && a.offset ? ` offset ${a.offset}` : ""}`;
  else {
    const args = JSON.stringify(a);
    what += ` ${args.length > 120 ? args.slice(0, 120) + "..." : args}`;
  }
  return `[Elided to save context: ${what}, ${e.content.length} characters. Call the tool again only if you need it for the next step.]`;
}

export function elideOld(entries: Entry[], tools: HarnessTool[]): number {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const done = doneTools(entries).filter((e) => !kept(e, byName));
  const replaced = outdatedReads(done, byName);
  const size = (e: ToolEntry) => (e.elided ? elisionNote(e).length : (replaced.get(e.id)?.length ?? e.content.length));
  if (done.reduce((sum, e) => sum + size(e), 0) <= ELIDE_AT) return 0;
  let newer = 0;
  let marked = 0;
  for (let i = done.length - 1; i >= 0; i--) {
    const e = done[i]!;
    if (newer >= KEEP_CHARS && !e.elided && !replaced.has(e.id) && e.content.length > LARGE_RESULT) {
      e.elided = true;
      marked++;
    }
    newer += size(e);
  }
  return marked;
}

export function prunedResults(entries: Entry[], tools: HarnessTool[]): Map<string, string> {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const done = doneTools(entries);
  const out = outdatedReads(done, byName);
  for (const e of done) if (e.elided && !out.has(e.id)) out.set(e.id, elisionNote(e));
  return out;
}
