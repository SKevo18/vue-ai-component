import type { McpClient } from "../mcp/client";
import type { ImageRef } from "./entries";
import type { ImageContent } from "./types";

export const READ_LIMIT = 40000;

export interface NamespaceContent {
  name?: string;
  mimeType?: string;
  text?: string;
  image?: ImageRef;
  page?: number;
  pages?: number;
}

export interface LocalNamespace {
  scheme: string;
  template: string;
  description: string;
  read(uri: string, options: { page: number; signal?: AbortSignal }): Promise<NamespaceContent>;
  image?(ref: ImageRef): Promise<ImageContent>;
}

export interface ReadOptions {
  offset?: number;
  limit?: number;
  page?: number;
  signal?: AbortSignal;
}

export interface ReadResult extends NamespaceContent {
  uri: string;
  offset: number;
  nextOffset?: number;
  totalChars?: number;
}

export interface NamespaceRegistry {
  register(namespace: LocalNamespace): () => void;
  local(): LocalNamespace[];
  read(uri: string, options?: ReadOptions): Promise<ReadResult>;
  image(ref: ImageRef): Promise<ImageContent>;
}

export function schemeOf(uri: string): string | null {
  return /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri.trim())?.[1]?.toLowerCase() ?? null;
}

function integer(value: number | undefined, fallback: number, minimum: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be an integer of at least ${minimum}.`);
  return value;
}

function betweenSurrogates(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return offset > 0 && offset < text.length && before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** never splits a surrogate pair */
export function textChunk(text: string, offset: number, limit: number): { text: string; offset: number; totalChars: number; nextOffset?: number } {
  if (offset > text.length) throw new RangeError(`offset ${offset} is past the end of the text (${text.length} characters).`);
  if (betweenSurrogates(text, offset)) throw new RangeError(`offset ${offset} splits a character; use ${offset - 1}.`);
  let end = Math.min(text.length, offset + limit);
  if (betweenSurrogates(text, end)) end--;
  if (end === offset && offset < text.length) throw new RangeError("limit is too small for the next character; use at least 2.");
  return { text: text.slice(offset, end), offset, totalChars: text.length, ...(end < text.length ? { nextOffset: end } : {}) };
}

const TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|javascript|yaml|x-yaml|toml)|image\/svg\+xml)/;
const CACHE_MS = 30_000;
const CACHE_SIZE = 8;
const IMAGE_CACHE_SIZE = 16;

export interface NamespaceRegistryOptions {
  mcp(): McpClient | null;
  prepareImage(image: ImageContent): Promise<ImageContent>;
}

export function createNamespaceRegistry(options: NamespaceRegistryOptions): NamespaceRegistry {
  const locals = new Map<string, LocalNamespace>();
  // chunked reads of one resource come in quick succession: keep recent MCP reads briefly
  const recent = new Map<string, { at: number; content: Promise<NamespaceContent> }>();
  const images = new Map<string, ImageContent>();

  function remember(uri: string, image: ImageContent) {
    images.delete(uri);
    images.set(uri, image);
    while (images.size > IMAGE_CACHE_SIZE) images.delete(images.keys().next().value!);
  }

  async function readMcp(uri: string, signal?: AbortSignal): Promise<NamespaceContent> {
    const client = options.mcp();
    if (!client) throw new Error(`No namespace serves ${uri}.`);
    const contents = await client.readResource(uri, { signal });
    if (!contents.length) throw new Error(`${uri} is empty.`);
    const texts: string[] = [];
    let image: ImageRef | undefined;
    for (const c of contents) {
      const label = contents.length > 1 ? `[${c.uri}]\n` : "";
      if ("text" in c) texts.push(label + c.text);
      else if (c.mimeType?.startsWith("image/") && c.mimeType !== "image/svg+xml") {
        if (!image) {
          remember(c.uri, { mimeType: c.mimeType, data: c.blob });
          image = { uri: c.uri };
        }
      } else if (c.mimeType && TEXT_TYPES.test(c.mimeType)) {
        texts.push(label + new TextDecoder().decode(Uint8Array.from(atob(c.blob), (ch) => ch.charCodeAt(0))));
      } else texts.push(`${label}[Binary content${c.mimeType ? ` (${c.mimeType})` : ""}, ${Math.floor((c.blob.length * 3) / 4)} bytes, cannot be shown as text.]`);
    }
    const first = contents[0]!;
    return { mimeType: first.mimeType, text: texts.length ? texts.join("\n\n") : undefined, image };
  }

  function cachedMcp(uri: string, signal?: AbortSignal): Promise<NamespaceContent> {
    const now = Date.now();
    for (const [key, value] of recent) if (now - value.at > CACHE_MS) recent.delete(key);
    const hit = recent.get(uri);
    if (hit) return hit.content;
    const content = readMcp(uri, signal);
    recent.set(uri, { at: now, content });
    content.catch(() => recent.delete(uri));
    while (recent.size > CACHE_SIZE) recent.delete(recent.keys().next().value!);
    return content;
  }

  return {
    register(namespace) {
      const scheme = namespace.scheme.toLowerCase();
      locals.set(scheme, namespace);
      return () => {
        if (locals.get(scheme) === namespace) locals.delete(scheme);
      };
    },
    local: () => [...locals.values()],
    async read(uri, opts = {}) {
      const trimmed = uri.trim();
      const scheme = schemeOf(trimmed);
      if (!scheme) throw new Error(`${uri} is not a URI. Use scheme://path, e.g. one listed under namespaces.`);
      const offset = integer(opts.offset, 0, 0, "offset");
      const limit = Math.min(READ_LIMIT, integer(opts.limit, READ_LIMIT, 1, "limit"));
      const page = integer(opts.page, 1, 1, "page");
      const local = locals.get(scheme);
      let content: NamespaceContent;
      if (local) content = await local.read(trimmed, { page, signal: opts.signal });
      else {
        if (page !== 1) throw new RangeError("Only PDF attachments have pages. Continue text with offset instead.");
        content = await cachedMcp(trimmed, opts.signal);
      }
      if (content.text === undefined) {
        if (offset !== 0) throw new RangeError("This resource has no text; use offset 0.");
        return { ...content, uri: trimmed, offset: 0 };
      }
      return { ...content, uri: trimmed, ...textChunk(content.text, offset, limit) };
    },
    async image(ref) {
      const local = locals.get(schemeOf(ref.uri) ?? "");
      if (local) {
        if (!local.image) throw new Error(`${ref.uri} has no image.`);
        return local.image(ref);
      }
      const cached = images.get(ref.uri);
      if (cached) remember(ref.uri, cached);
      const data = cached ?? (await readMcp(ref.uri).then((content) => content.image && images.get(content.image.uri)));
      if (!data) throw new Error(`${ref.uri} is not an image.`);
      return options.prepareImage(data);
    },
  };
}
