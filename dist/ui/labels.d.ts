import type { Usage } from "../core/types";
import type { Translate } from "../i18n";
export declare function toolLabel(name: string, t: Translate, title?: string): string;
/** empty strings and nulls are shown, since a call may clear a field with them */
export declare function argRows(args: Record<string, unknown>): {
    key: string;
    value: string;
    long: boolean;
}[];
export declare function compactNumber(n: number, locale: string): string;
export declare function usageText(usage: Usage, t: Translate, locale: string): string;
export declare function toolList(names: string[], t: Translate, locale: string, titles?: Record<string, string>): string;
