import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The `## ` headings and `**Label:**` lines of a template. */
const outline = (text: string) => text.split(/\r?\n/).filter((line) => /^## |^\*\*[^*]+:\*\*/.test(line)).map((line) => line.replace(/:\*\*.*/, ":**"));

describe("forge-feedback", () => {
  it("has the same issue template as the repo's GitHub template", () => {
    const skill = readFileSync(new URL("../skills/forge-feedback/SKILL.md", import.meta.url), "utf8");
    const block = /```markdown\r?\n([\s\S]*?)```/.exec(skill)?.[1] ?? "";
    const repo = readFileSync(new URL("../.github/ISSUE_TEMPLATE/agent-feedback.md", import.meta.url), "utf8");
    expect(outline(block).length).toBeGreaterThan(4);
    expect(outline(block)).toEqual(outline(repo));
  });
});
