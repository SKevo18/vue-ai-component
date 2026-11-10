// models send numbers as strings and forget required fields; a local check saves a round trip. Unknown keywords and
// composite schemas are left to the server.
import type { JsonSchema } from "./types";

function types(schema: JsonSchema): string[] {
  if (Array.isArray(schema.type)) return schema.type;
  return typeof schema.type === "string" ? [schema.type] : [];
}

function single(schema: JsonSchema): string | null {
  const t = types(schema).filter((x) => x !== "null");
  return t.length === 1 ? t[0]! : null;
}

export function validate(schema: JsonSchema, value: unknown, path = "arguments"): string[] {
  if (value === null && types(schema).includes("null")) return [];
  const errors: string[] = [];
  switch (single(schema)) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [`${path} must be an object`];
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined) errors.push(`${path}.${key} is required`);
      }
      for (const [key, v] of Object.entries(obj)) {
        const sub = schema.properties?.[key];
        if (!sub) {
          if (schema.additionalProperties === false) errors.push(`${path}.${key} is not a known parameter`);
          continue;
        }
        if (v === undefined) continue;
        errors.push(...validate(sub, v, `${path}.${key}`));
      }
      return errors;
    }
    case "array":
      if (!Array.isArray(value)) return [`${path} must be an array`];
      if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items!, v, `${path}[${i}]`)));
      return errors;
    case "string":
      if (typeof value !== "string") return [`${path} must be a string`];
      if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} must have at least ${schema.minLength} characters`);
      if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
      return errors;
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return [`${path} must be a number`];
      if (single(schema) === "integer" && !Number.isInteger(value)) errors.push(`${path} must be an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
      return errors;
    }
    default:
      return [];
  }
}

export function coerce(schema: JsonSchema, value: unknown): unknown {
  const t = single(schema);
  if (t === "object" && typeof value === "string" && value.trim().startsWith("{")) {
    try {
      return coerce(schema, JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (t === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const sub = schema.properties?.[k];
      out[k] = sub ? coerce(sub, v) : v;
    }
    return out;
  }
  if ((t === "integer" || t === "number") && typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (t === "boolean" && (value === "true" || value === "false")) return value === "true";
  if (t === "array" && Array.isArray(value) && schema.items) return value.map((v) => coerce(schema.items!, v));
  return value;
}
