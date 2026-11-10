import type { Entry } from "./entries";
export declare const PLAN_STATUSES: readonly ["pending", "active", "done", "dropped"];
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export interface PlanStep {
    text: string;
    status: PlanStatus;
}
export declare const PLAN_TOOL = "update_plan";
export declare const PLAN_REMINDERS = 3;
/** exactly one active step while any is open: the first active one stays, a plan without one starts its first pending step */
export declare function normalizePlan(steps: PlanStep[]): PlanStep[];
export declare function openSteps(plan: PlanStep[]): PlanStep[];
export declare function planText(plan: PlanStep[]): string;
export declare function parseSteps(value: unknown): PlanStep[] | null;
export declare function currentPlan(entries: Entry[]): PlanStep[] | null;
export declare function planReminder(plan: PlanStep[], n: number): string;
