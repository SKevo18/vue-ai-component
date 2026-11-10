import type { NamespaceRegistry, ReadResult } from "./namespaces";
import type { HarnessTool } from "./tools";
export declare function formatRead(r: ReadResult): string;
export declare function readTool(registry: NamespaceRegistry): HarnessTool;
export declare const planTool: HarnessTool;
