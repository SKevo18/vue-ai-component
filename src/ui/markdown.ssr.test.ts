// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderMarkdown, sanitizeHtml } from "./markdown";

describe("sanitizeHtml without a DOM", () => {
  it("escapes instead of passing HTML through", () => {
    expect(sanitizeHtml('<img src="https://evil.example/a.png" onerror="dig()">')).toBe("&lt;img src=&quot;https://evil.example/a.png&quot; onerror=&quot;dig()&quot;&gt;");
    expect(renderMarkdown("**otter**")).not.toContain("<strong>");
  });
});
