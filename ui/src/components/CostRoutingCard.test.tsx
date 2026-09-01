// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { OrchestrationCostExclusions, OrchestrationCostReport } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CostRoutingCard, basisRatio, formatRatio } from "./CostRoutingCard";

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
    basis: "indeterminate" as const,
    ...overrides,
  };
}

function exclusions(overrides: Partial<OrchestrationCostExclusions> = {}): OrchestrationCostExclusions {
  return {
    totalEventCount: 0,
    totalCostCents: 0,
    countedEventCount: 0,
    countedCostCents: 0,
    heldOutCostCents: 0,
    noIssueEventCount: 0,
    noIssueCostCents: 0,
    noRunEventCount: 0,
    noRunCostCents: 0,
    unresolvedIssueEventCount: 0,
    unresolvedIssueCostCents: 0,
    hiddenTreeEventCount: 0,
    hiddenTreeCostCents: 0,
    ...overrides,
  };
}

const thresholds = { minClassifiedCents: 100, minClassifiedTokens: 1_000_000 };

const emptyReport: OrchestrationCostReport = {
  summary: {
    companyId: "company-1",
    issueCount: 0,
    treeCount: 0,
    judgedTreeCount: 0,
    invertedTreeCount: 0,
    exclusions: exclusions(),
    ...measures(),
  },
  trees: [],
  byDepth: [],
  thresholds,
};

const populatedReport: OrchestrationCostReport = {
  summary: {
    companyId: "company-1",
    issueCount: 3,
    treeCount: 1,
    judgedTreeCount: 1,
    invertedTreeCount: 1,
    exclusions: exclusions({
      totalEventCount: 9,
      totalCostCents: 1400,
      countedEventCount: 7,
      countedCostCents: 1300,
      heldOutCostCents: 200,
      noIssueEventCount: 2,
      noIssueCostCents: 100,
    }),
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
      orchestrationCostRatio: 0.7,
      orchestrationTokenRatio: 0.7,
      unpricedEventCount: 5,
      subscriptionEventCount: 3,
      basis: "cents",
    }),
  },
  trees: [
    {
      rootIssueId: "issue-1",
      rootIssueIdentifier: "PAP-1",
      rootIssueTitle: "Rebuild the billing pipeline",
      issueCount: 3,
      maxRequestDepth: 2,
      inFlight: false,
      overheadVerdict: "inverted",
      ...measures({
        orchestrationRunCount: 4,
        executionRunCount: 2,
        unclassifiedRunCount: 1,
        orchestrationCents: 700,
        executionCents: 300,
        unclassifiedCents: 100,
        totalCents: 1100,
        orchestrationCostRatio: 0.7,
        basis: "cents",
      }),
    },
  ],
  byDepth: [
    {
      requestDepth: 0,
      issueCount: 1,
      ...measures({
        orchestrationCents: 700,
        totalCents: 700,
        orchestrationCostRatio: 1,
        basis: "cents",
      }),
    },
    {
      requestDepth: 1,
      issueCount: 2,
      ...measures({
        executionCents: 300,
        totalCents: 300,
        orchestrationCostRatio: 0,
        basis: "cents",
      }),
    },
  ],
  thresholds,
};

const subscriptionOnlyReport: OrchestrationCostReport = {
  summary: {
    companyId: "company-1",
    issueCount: 1,
    treeCount: 1,
    judgedTreeCount: 1,
    invertedTreeCount: 1,
    exclusions: exclusions({ totalEventCount: 6, countedEventCount: 6 }),
    ...measures({
      orchestrationRunCount: 2,
      executionRunCount: 1,
      orchestrationTokens: 8_000_000,
      executionTokens: 2_000_000,
      totalTokens: 10_000_000,
      orchestrationTokenRatio: 0.8,
      subscriptionEventCount: 6,
      basis: "tokens",
    }),
  },
  trees: [],
  byDepth: [],
  thresholds,
};

/**
 * The finding-1 shape: a metered manager over a subscription-billed executor.
 * Cents say 100% orchestration, tokens say 2%, and the server refuses to pick.
 */
const mixedBillingReport: OrchestrationCostReport = {
  summary: {
    companyId: "company-1",
    issueCount: 2,
    treeCount: 1,
    judgedTreeCount: 0,
    invertedTreeCount: 0,
    exclusions: exclusions({
      totalEventCount: 2,
      totalCostCents: 300,
      countedEventCount: 2,
      countedCostCents: 300,
    }),
    ...measures({
      orchestrationRunCount: 1,
      executionRunCount: 1,
      orchestrationCents: 300,
      totalCents: 300,
      orchestrationTokens: 100_000,
      executionTokens: 5_000_000,
      totalTokens: 5_100_000,
      orchestrationCostRatio: 1,
      orchestrationTokenRatio: 0.0196,
      subscriptionEventCount: 1,
      basis: "indeterminate",
    }),
  },
  trees: [
    {
      rootIssueId: "issue-9",
      rootIssueIdentifier: "PAP-9",
      rootIssueTitle: "Mixed billing tree",
      issueCount: 2,
      maxRequestDepth: 1,
      inFlight: false,
      overheadVerdict: "indeterminate",
      ...measures({
        orchestrationRunCount: 1,
        executionRunCount: 1,
        orchestrationCents: 300,
        totalCents: 300,
        orchestrationTokens: 100_000,
        executionTokens: 5_000_000,
        totalTokens: 5_100_000,
        orchestrationCostRatio: 1,
        orchestrationTokenRatio: 0.0196,
        subscriptionEventCount: 1,
        basis: "indeterminate",
      }),
    },
  ],
  byDepth: [],
  thresholds,
};

describe("formatRatio", () => {
  it("renders a percentage and an em dash for a missing ratio", () => {
    expect(formatRatio(0.6364)).toBe("64%");
    expect(formatRatio(0)).toBe("0%");
    expect(formatRatio(null)).toBe("—");
  });
});

describe("basisRatio", () => {
  it("reads the ratio that matches the server-declared basis and nothing else", () => {
    expect(
      basisRatio(measures({ basis: "cents", orchestrationCostRatio: 0.7, orchestrationTokenRatio: 0.1 })),
    ).toBe(0.7);
    expect(
      basisRatio(measures({ basis: "tokens", orchestrationCostRatio: 0.7, orchestrationTokenRatio: 0.1 })),
    ).toBe(0.1);
    // an indeterminate group has both numbers and no verdict; neither may win
    expect(
      basisRatio(measures({ basis: "indeterminate", orchestrationCostRatio: 1, orchestrationTokenRatio: 0.02 })),
    ).toBeNull();
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

    expect(container.textContent).toContain("70%");
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
    expect(container.textContent).toContain("2 of 9 cost events in range");
    expect(container.textContent).toContain("2 no issue");
  });

  it("falls back to a token basis when a company has no priced spend", () => {
    render(subscriptionOnlyReport);

    expect(container.textContent).toContain("80%");
    expect(container.textContent).toContain("Measured on tokens — no priced spend in range");
  });

  it("shows no verdict and no ratio when metered and subscription billing are mixed", () => {
    render(mixedBillingReport);

    // the cents ratio is 100% and the token ratio is 2%; neither is rendered
    expect(container.textContent).not.toContain("100%");
    expect(container.textContent).not.toContain("2%");
    expect(container.textContent).toContain("Not comparable — priced and held-out rows are mixed");
    expect(container.textContent).not.toContain("Orchestration-heavy");
    expect(container.textContent).toContain("Not comparable");
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
