import type { Entry } from "./entries";

export const PLAN_STATUSES = ["pending", "active", "done", "dropped"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export interface PlanStep {
  text: string;
  status: PlanStatus;
}

export const PLAN_TOOL = "update_plan";
export const PLAN_REMINDERS = 3;

/** exactly one active step while any is open: the first active one stays, a plan without one starts its first pending step */
export function normalizePlan(steps: PlanStep[]): PlanStep[] {
  let active = false;
  const out = steps.map((s) => {
    if (s.status !== "active") return { ...s };
    if (active) return { ...s, status: "pending" as const };
    active = true;
    return { ...s };
  });
  if (!active) {
    const next = out.find((s) => s.status === "pending");
    if (next) next.status = "active";
  }
  return out;
}

export function openSteps(plan: PlanStep[]): PlanStep[] {
  return plan.filter((s) => s.status === "pending" || s.status === "active");
}

export function planText(plan: PlanStep[]): string {
  const done = plan.filter((s) => s.status === "done").length;
  const mark: Record<PlanStatus, string> = { pending: "[ ]", active: "[>]", done: "[x]", dropped: "[-]" };
  return [`Plan: ${done}/${plan.length} done, ${openSteps(plan).length} open.`, ...plan.map((s) => `${mark[s.status]} ${s.text}`)].join("\n");
}

export function parseSteps(value: unknown): PlanStep[] | null {
  if (!Array.isArray(value)) return null;
  const steps: PlanStep[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || !("text" in item) || !("status" in item)) return null;
    const { text, status } = item;
    const known = PLAN_STATUSES.find((s) => s === status);
    if (typeof text !== "string" || !known) return null;
    steps.push({ text, status: known });
  }
  return steps;
}

export function currentPlan(entries: Entry[]): PlanStep[] | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.role !== "tool" || e.name !== PLAN_TOOL || e.isError || e.status !== "done") continue;
    const steps = parseSteps(e.args.steps);
    return steps ? normalizePlan(steps) : null;
  }
  return null;
}

export function planReminder(plan: PlanStep[], n: number): string {
  const open = openSteps(plan);
  return `<system-reminder>\nYou stopped with ${open.length} unfinished plan step${open.length === 1 ? "" : "s"}:\n${open.map((s) => `- ${s.text}`).join("\n")}\n\nContinue working on them, or mark them done or dropped with update_plan. If you need a decision from the user, ask the question and stop.\n(Reminder ${n}/${PLAN_REMINDERS})\n</system-reminder>`;
}
