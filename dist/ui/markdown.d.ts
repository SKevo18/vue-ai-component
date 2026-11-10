import type { MarkdownIt as MarkdownItInstance } from "markdown-it";
export declare function resourceLinks(md: MarkdownItInstance): void;
/**
 * sanitises HTML with the package's DOMPurify settings (SVG and MathML stay). Remote images and other resources the
 * browser would fetch on its own are dropped; same-origin, `data:` and `blob:` URLs stay. Without a DOM it escapes.
 */
export declare function sanitizeHtml(html: string): string;
export declare function renderMarkdown(source: string): string;
