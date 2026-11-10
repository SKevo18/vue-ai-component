import { PLAN_TOOL } from "../core/plan";
import { READ_TOOL } from "../core/pruning";
import type { Usage } from "../core/types";
import type { Translate } from "../i18n";

export function toolLabel(name: string, t: Translate, title?: string): string {
  if (name === READ_TOOL) return t("tool.read");
  if (name === PLAN_TOOL) return t("tool.plan");
  if (title) return title;
  const words = name.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** empty strings and nulls are shown, since a call may clear a field with them */
export function argRows(args: Record<string, unknown>): { key: string; value: string; long: boolean }[] {
  return Object.entries(args)
    .filter(([, v]) => v !== undefined)
    .map(([key, v]) => {
      const value = typeof v === "string" && v !== "" ? v : JSON.stringify(v, null, 2);
      return { key, value, long: value.length > 80 || value.includes("\n") };
    });
}

export function compactNumber(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function usageText(usage: Usage, t: Translate, locale: string): string {
  const input = compactNumber(usage.input, locale);
  const output = compactNumber(usage.output, locale);
  return usage.cached ? t("usageCached", { input, cached: compactNumber(usage.cached, locale), output }) : t("usage", { input, output });
}

export function toolList(names: string[], t: Translate, locale: string, titles: Record<string, string> = {}): string {
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(names.map((n) => toolLabel(n, t, titles[n])));
}
