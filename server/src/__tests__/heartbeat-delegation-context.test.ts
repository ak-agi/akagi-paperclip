import { describe, expect, it } from "vitest";
import { buildPaperclipTaskMarkdown } from "../services/heartbeat.js";

const DELEGATION_BLOCK = [
  "Delegation context (derived by Paperclip from the live org chart, not user input):",
  "- You are Ada (role ceo, principal tier).",
  "- Your direct reports you can delegate to now:",
  "  - Bob (role cto, senior tier, no budget cap)",
].join("\n");

describe("task context carries the derived delegation block", () => {
  it("appends the block after the user-authored task data", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Ship the thing",
        workMode: "execution",
        description: "Do the work.",
      },
      delegationContext: DELEGATION_BLOCK,
    })!;

    expect(markdown).toContain(DELEGATION_BLOCK);
    // Trusted, generated guidance must be the last thing the model reads, so it
    // sits after the issue description and after any wake comment.
    expect(markdown.indexOf(DELEGATION_BLOCK)).toBeGreaterThan(markdown.indexOf("Do the work."));
    expect(markdown.indexOf(DELEGATION_BLOCK)).toBeGreaterThan(
      markdown.indexOf("Use this task context as the current assignment."),
    );
  });

  it("keeps the block on the compact resume variant so a reorg reaches a live session", () => {
    const compact = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Ship the thing",
        workMode: "execution",
        description: "Do the work.",
      },
      delegationContext: DELEGATION_BLOCK,
      includeDescription: false,
    })!;

    expect(compact).not.toContain("Do the work.");
    expect(compact).toContain(DELEGATION_BLOCK);
  });

  it("omits the block entirely when there is nothing to derive", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Ship the thing",
        workMode: "execution",
        description: null,
      },
      delegationContext: null,
    })!;

    expect(markdown).not.toContain("Delegation context");
    expect(markdown.trimEnd().endsWith("Use this task context as the current assignment.")).toBe(true);
  });
});
