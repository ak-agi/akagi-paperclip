import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The delegate-or-do rule and the escalation rule live in the per-wake
// `Delegation context` block. Persisted operating instructions outrank a
// per-wake block in practice, so an absolute "delegate everything" line in a
// CEO bundle makes the generated guardrail dead on arrival — for exactly the
// agent whose orchestration overhead the guardrail exists to bound.
const CEO_BUNDLES = [
  fileURLToPath(new URL("../onboarding-assets/ceo/AGENTS.md", import.meta.url)),
  fileURLToPath(
    new URL(
      "../../../packages/teams-catalog/catalog/bundled/company-defaults/core-exec-team/agents/ceo/AGENTS.md",
      import.meta.url,
    ),
  ),
];

describe("built-in CEO instructions and the derived delegation context", () => {
  it.each(CEO_BUNDLES)("does not contradict the delegate-or-do rule (%s)", (path) => {
    const body = readFileSync(path, "utf8");

    for (const absolute of [
      "Even if a task seems small or quick, delegate it",
      "Even small or quick tasks get delegated",
      "You MUST delegate work rather than doing it yourself",
    ]) {
      expect(body).not.toContain(absolute);
    }
    // It must still point at the generated block, and it must defer to the
    // delegate-or-do rule rather than overriding it.
    expect(body).toContain("`Delegation context`");
    expect(body).toContain("delegate-or-do rule");
  });

  it("routes by the live org chart instead of a hardcoded role", () => {
    const body = readFileSync(CEO_BUNDLES[0]!, "utf8");
    // The whole point of the derived block is that no company-specific role is
    // baked into the bundle. "default to the CTO" is wrong for every company
    // without a CTO, which is the class of prose this feature removed.
    expect(body).not.toContain("default to the CTO");
    expect(body).not.toMatch(/\bCTO\b/);
  });
});
