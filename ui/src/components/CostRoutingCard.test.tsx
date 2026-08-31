// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { OrchestrationCostReport } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostRoutingCard, formatRatio, orchestrationBasis } from "./CostRoutingCard";

function measures(overrides: Partial<OrchestrationCostReport["summary"]> = {}) {
  return {
    orchestrationRunCount: 0,
    executionRunCount: 0,
    unclassifiedRunCount: 0,
    orchestrationCents: 0,
    executionCents: 0,
    unclassifiedCents: 0,
    totalCents: 0,
    orchestrationTokens: 0,
    executionTokens: 0,
    unclassifiedTokens: 0,
    totalTokens: 0,
    orchestrationCostRatio: null,
    orchestrationTokenRatio: null,
    unpricedEventCount: 0,
    subscriptionEventCount: 0,
    ...overrides,
  };
}

const emptyReport: OrchestrationCostReport = {
  summary: {
    companyId: "company-1",
    issueCount: 0,
    invertedTreeCount: 0,
    unattributedEventCount: 0,
    ...measures(),
  },
  trees: [],
  byDepth: [],
};

const populatedReport: OrchestrationCostReport = {
  summary: {
    companyId: "company-1",
    issueCount: 3,
    invertedTreeCount: 1,
    unattributedEventCount: 2,
    ...measures({
      orchestrationRunCount: 4,
      executionRunCount: 2,
      unclassifiedRunCount: 1,
      orchestrationCents: 700,
      executionCents: 300,
      unclassifiedCents: 100,
      totalCents: 1100,
      orchestrationTokens: 7000,
      executionTokens: 3000,
      unclassifiedTokens: 1000,
      totalTokens: 11000,
      orchestrationCostRatio: 0.6364,
      orchestrationTokenRatio: 0.6364,
      unpricedEventCount: 5,
      subscriptionEventCount: 3,
    }),
  },
  trees: [
    {
      rootIssueId: "issue-1",
      rootIssueIdentifier: "PAP-1",
      rootIssueTitle: "Rebuild the billing pipeline",
      issueCount: 3,
      maxRequestDepth: 2,
      overheadInverted: true,
      ...measures({
        orchestrationRunCount: 4,
        executionRunCount: 2,
        unclassifiedRunCount: 1,
        orchestrationCents: 700,
        executionCents: 300,
        unclassifiedCents: 100,
        totalCents: 1100,
        orchestrationCostRatio: 0.6364,
      }),
    },
  ],
  byDepth: [
    {
      requestDepth: 0,
      issueCount: 1,
      ...measures({ orchestrationCents: 700, totalCents: 700, orchestrationCostRatio: 1 }),
    },
    {
      requestDepth: 1,
      issueCount: 2,
      ...measures({ executionCents: 300, totalCents: 300, orchestrationCostRatio: 0 }),
    },
  ],
};

const subscriptionOnlyReport: OrchestrationCostReport = {
  summary: {
    companyId: "company-1",
    issueCount: 1,
    invertedTreeCount: 1,
    unattributedEventCount: 0,
    ...measures({
      orchestrationRunCount: 2,
      executionRunCount: 1,
      orchestrationTokens: 800,
      executionTokens: 200,
      totalTokens: 1000,
      orchestrationTokenRatio: 0.8,
      subscriptionEventCount: 6,
    }),
  },
  trees: [],
  byDepth: [],
};

describe("formatRatio", () => {
  it("renders a percentage and an em dash for a missing ratio", () => {
    expect(formatRatio(0.6364)).toBe("64%");
    expect(formatRatio(0)).toBe("0%");
    expect(formatRatio(null)).toBe("—");
  });
});

describe("orchestrationBasis", () => {
  it("prefers priced cost, falls back to tokens, then to nothing", () => {
    expect(orchestrationBasis(measures({ totalCents: 10, totalTokens: 100 }))).toBe("cost");
    expect(orchestrationBasis(measures({ totalTokens: 100 }))).toBe("tokens");
    expect(orchestrationBasis(measures())).toBe("none");
  });
});

describe("CostRoutingCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  function render(report: OrchestrationCostReport) {
    root = createRoot(container);
    flushSync(() => {
      root?.render(<CostRoutingCard report={report} />);
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders empty states when nothing is attributed yet", () => {
    render(emptyReport);

    expect(container.textContent).toContain("Orchestration overhead");
    expect(container.textContent).toContain("No attributed spend yet");
    expect(container.textContent).toContain("No delegation recorded");
    expect(container.textContent).toContain("—");
  });

  it("renders the orchestration share, the tree table, and the depth breakdown", () => {
    render(populatedReport);

    expect(container.textContent).toContain("64%");
    expect(container.textContent).toContain("PAP-1");
    expect(container.textContent).toContain("Rebuild the billing pipeline");
    expect(container.textContent).toContain("depth 0");
    expect(container.textContent).toContain("depth 1");
    expect(container.textContent).toContain("Measured on priced, metered spend");
  });

  it("flags a tree whose orchestration cost exceeds its execution cost", () => {
    render(populatedReport);

    expect(container.textContent).toContain("Orchestration-heavy");
    expect(container.textContent).toContain("Inverted trees");
  });

  it("labels the rows held out of the cost ratio", () => {
    render(populatedReport);

    expect(container.textContent).toContain("5 unpriced · 3 subscription");
    expect(container.textContent).toContain("2 cost events in range carry no issue");
  });

  it("falls back to a token basis when a company has no priced spend", () => {
    render(subscriptionOnlyReport);

    expect(container.textContent).toContain("80%");
    expect(container.textContent).toContain("Measured on tokens — no priced spend in range");
  });

  it("gives every split meter an accessible label so identity is not colour-only", () => {
    render(populatedReport);

    const meters = container.querySelectorAll('[role="img"]');
    expect(meters.length).toBeGreaterThan(0);
    for (const meter of Array.from(meters)) {
      expect(meter.getAttribute("aria-label")).toBeTruthy();
    }
    expect(container.textContent).toContain("Orchestration");
    expect(container.textContent).toContain("Execution");
    expect(container.textContent).toContain("Unclassified");
  });
});
