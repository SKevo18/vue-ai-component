export interface DiffRow {
  type: "same" | "add" | "del";
  text: string;
}

/** the LCS stays bounded; oversized inputs show a replacement summary, never a misleading partial diff */
export function approvalDiff(before: string, after: string): { rows: (DiffRow | { type: "skip"; count: number })[]; added: number; removed: number; truncated: boolean } {
  if (before === after) return { rows: [], added: 0, removed: 0, truncated: false };
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > 600 || b.length > 600 || before.length + after.length > 120000) return { rows: [], added: b.length, removed: a.length, truncated: true };
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i++]! });
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ type: "del", text: a[i++]! });
      removed++;
    } else {
      rows.push({ type: "add", text: b[j++]! });
      added++;
    }
  }
  for (; i < n; i++) {
    rows.push({ type: "del", text: a[i]! });
    removed++;
  }
  for (; j < m; j++) {
    rows.push({ type: "add", text: b[j]! });
    added++;
  }
  const keep = new Set<number>();
  rows.forEach((row, index) => {
    if (row.type !== "same") for (let k = Math.max(0, index - 2); k <= Math.min(rows.length - 1, index + 2); k++) keep.add(k);
  });
  const compact: (DiffRow | { type: "skip"; count: number })[] = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    if (keep.has(index)) {
      if (skipped) compact.push({ type: "skip", count: skipped });
      skipped = 0;
      compact.push(row);
    } else skipped++;
  });
  if (skipped) compact.push({ type: "skip", count: skipped });
  return { rows: compact, added, removed, truncated: false };
}
