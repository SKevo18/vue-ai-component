import type { Directive } from "vue";
export type TooltipValue = string | {
    text: string;
    keys?: string;
} | null | undefined;
export declare const vTooltip: Directive<HTMLElement, TooltipValue>;
