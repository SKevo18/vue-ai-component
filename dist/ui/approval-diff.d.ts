export interface DiffRow {
    type: "same" | "add" | "del";
    text: string;
}
/** the LCS stays bounded; oversized inputs show a replacement summary, never a misleading partial diff */
export declare function approvalDiff(before: string, after: string): {
    rows: (DiffRow | {
        type: "skip";
        count: number;
    })[];
    added: number;
    removed: number;
    truncated: boolean;
};
