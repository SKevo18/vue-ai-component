import type { JsonSchema } from "./types";
export declare function validate(schema: JsonSchema, value: unknown, path?: string): string[];
export declare function coerce(schema: JsonSchema, value: unknown): unknown;
