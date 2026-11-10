import DOMPurify, { type DOMPurify as Purifier } from "dompurify";
import MarkdownIt from "markdown-it";
import type { MarkdownIt as MarkdownItInstance, Token } from "markdown-it";

const WEB = /^(?:https?|mailto|tel):/i;
const RESOURCE = /\b([a-z][a-z0-9+.-]*):\/\/[^\s<>()[\]`"'{}|\\^]*[^\s<>()[\]`"'{}|\\^.,;:!?]/gi;
const NOT_RESOURCE = /^(?:https?|ftp|file|data|javascript|vbscript|blob|ws|wss)$/i;

function isResource(uri: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri)?.[1];
  return !!scheme && !NOT_RESOURCE.test(scheme);
}

export function resourceLinks(md: MarkdownItInstance): void {
  md.core.ruler.push("ai_resources", (state) => {
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      const out: Token[] = [];
      let inLink = 0;
      for (const tok of block.children) {
        if (tok.type === "link_open") inLink++;
        if (tok.type === "link_close") inLink--;
        if (tok.type === "code_inline" && !inLink && isResource(tok.content.trim()) && /^\S+$/.test(tok.content.trim())) {
          const open = new state.Token("link_open", "a", 1);
          open.attrs = [["href", tok.content.trim()]];
          out.push(open, tok, new state.Token("link_close", "a", -1));
          continue;
        }
        if (tok.type !== "text" || inLink) {
          out.push(tok);
          continue;
        }
        let last = 0;
        for (const m of tok.content.matchAll(RESOURCE)) {
          if (NOT_RESOURCE.test(m[1]!)) continue;
          const at = m.index;
          if (at > last) {
            const t = new state.Token("text", "", 0);
            t.content = tok.content.slice(last, at);
            out.push(t);
          }
          const open = new state.Token("link_open", "a", 1);
          open.attrs = [["href", m[0]]];
          const text = new state.Token("text", "", 0);
          text.content = m[0];
          out.push(open, text, new state.Token("link_close", "a", -1));
          last = at + m[0].length;
        }
        if (last === 0) out.push(tok);
        else if (last < tok.content.length) {
          const t = new state.Token("text", "", 0);
          t.content = tok.content.slice(last);
          out.push(t);
        }
      }
      block.children = out;
    }
  });

  const previousLink = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const tok = tokens[idx]!;
    const href = String(tok.attrGet("href") ?? "");
    if (isResource(href)) {
      tok.attrSet("href", "#");
      tok.attrSet("data-ai-resource", href);
      tok.attrSet("class", "ai-resource-link");
    } else if (WEB.test(href)) {
      tok.attrSet("target", "_blank");
      tok.attrSet("rel", "noopener noreferrer");
    }
    return previousLink?.(tokens, idx, options, _env, self) ?? self.renderToken(tokens, idx, options);
  };
}

/** images become links, so model output never makes the browser fetch a URL by itself */
function imagesAsLinks(md: MarkdownItInstance): void {
  md.core.ruler.push("ai_images", (state) => {
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      block.children = block.children.flatMap((tok) => {
        if (tok.type !== "image") return [tok];
        const src = String(tok.attrGet("src") ?? "");
        const open = new state.Token("link_open", "a", 1);
        open.attrs = [["href", src]];
        const label = new state.Token("text", "", 0);
        label.content = tok.content || src;
        return [open, label, new state.Token("link_close", "a", -1)];
      });
    }
  });
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false }).use(imagesAsLinks).use(resourceLinks);

md.renderer.rules.fence = (tokens, idx) => {
  const tok = tokens[idx]!;
  const lang = tok.info.trim().split(/\s+/)[0] ?? "";
  return `<pre class="ai-code"${lang ? ` data-lang="${md.utils.escapeHtml(lang)}"` : ""}><code>${md.utils.escapeHtml(tok.content)}</code></pre>\n`;
};

const SANITIZE = { ADD_ATTR: ["target", "data-ai-resource", "data-lang"], FORBID_TAGS: ["style", "form", "input"] };
const FETCHING: Record<string, true> = { src: true, srcset: true, poster: true, background: true, href: true, "xlink:href": true };
const LINKS: Record<string, true> = { a: true, area: true };

function localUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  try {
    const url = new URL(trimmed, document.baseURI);
    return url.protocol === "data:" || url.protocol === "blob:" || url.origin === location.origin;
  } catch {
    return false;
  }
}

function localSrcset(value: string): boolean {
  return value.split(",").every((candidate) => localUrl(candidate.trim().split(/\s+/)[0] ?? ""));
}

let purifier: Purifier | null = null;

// a private instance, so the hook does not change the app's own DOMPurify
function getPurifier(): Purifier {
  if (purifier) return purifier;
  const instance = DOMPurify(window);
  instance.addHook("uponSanitizeAttribute", (node, data) => {
    const name = data.attrName;
    if (name === "style") {
      if (/url\s*\(|image-set\s*\(|@import/i.test(data.attrValue)) data.keepAttr = false;
      return;
    }
    if (!FETCHING[name] || (name.endsWith("href") && LINKS[node.nodeName.toLowerCase()])) return;
    if (!(name === "srcset" ? localSrcset(data.attrValue) : localUrl(data.attrValue))) data.keepAttr = false;
  });
  purifier = instance;
  return instance;
}

/**
 * sanitises HTML with the package's DOMPurify settings (SVG and MathML stay). Remote images and other resources the
 * browser would fetch on its own are dropped; same-origin, `data:` and `blob:` URLs stay. Without a DOM it escapes.
 */
export function sanitizeHtml(html: string): string {
  if (typeof window === "undefined" || !DOMPurify.isSupported) return md.utils.escapeHtml(html);
  return getPurifier().sanitize(html, SANITIZE);
}

export function renderMarkdown(source: string): string {
  return sanitizeHtml(md.render(source));
}
