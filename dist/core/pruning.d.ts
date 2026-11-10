import type { Entry } from "./entries";
import type { HarnessTool } from "./tools";
/** tool output (characters) that stays whole after a batch: the newest results */
export declare const KEEP_CHARS = 120000;
export declare const ELIDE_AT = 320000;
export declare const READ_TOOL = "read";
export declare function elideOld(entries: Entry[], tools: HarnessTool[]): number;
export declare function prunedResults(entries: Entry[], tools: HarnessTool[]): Map<string, string>;
