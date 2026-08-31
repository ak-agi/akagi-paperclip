// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrchestrationCostReport } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Costs } from "./Costs";

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

const mockCostsApi = vi.hoisted(() => ({
  summary: vi.fn(),
  byAgent: vi.fn(),
  byAgentModel: vi.fn(),
  byProject: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  financeSummary: vi.fn(),
  financeByBiller: vi.fn(),
  financeByKind: vi.fn(),
  financeEvents: vi.fn(),
  windowSpend: vi.fn(),
  quotaWindows: vi.fn(),
  routing: vi.fn(),
}));

const mockBudgetsApi = vi.hoisted(() => ({
  overview: vi.fn(),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("@/api/costs", () => ({ costsApi: mockCostsApi }));
vi.mock("@/api/budgets", () => ({ budgetsApi: mockBudgetsApi }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));

const routingReport: OrchestrationCostReport = {
  summary: {
    companyId: "company-1",
    issueCount: 2,
    invertedTreeCount: 1,
    unattributedEventCount: 0,
    orchestrationRunCount: 3,
    executionRunCount: 1,
    unclassifiedRunCount: 0,
    orchestrationCents: 600,
    executionCents: 400,
    unclassifiedCents: 0,
    totalCents: 1000,
    orchestrationTokens: 600,
    executionTokens: 400,
    unclassifiedTokens: 0,
    totalTokens: 1000,
    orchestrationCostRatio: 0.6,
    orchestrationTokenRatio: 0.6,
    unpricedEventCount: 0,
    subscriptionEventCount: 0,
  },
  trees: [
    {
      rootIssueId: "issue-1",
      rootIssueIdentifier: "PAP-42",
      rootIssueTitle: "Migrate the org chart",
      issueCount: 2,
      maxRequestDepth: 1,
      overheadInverted: true,
      orchestrationRunCount: 3,
      executionRunCount: 1,
      unclassifiedRunCount: 0,
      orchestrationCents: 600,
      executionCents: 400,
      unclassifiedCents: 0,
      totalCents: 1000,
      orchestrationTokens: 600,
      executionTokens: 400,
      unclassifiedTokens: 0,
      totalTokens: 1000,
      orchestrationCostRatio: 0.6,
      orchestrationTokenRatio: 0.6,
      unpricedEventCount: 0,
      subscriptionEventCount: 0,
    },
  ],
  byDepth: [],
};

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("Costs routing tab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    mockCostsApi.summary.mockResolvedValue({
      companyId: "company-1",
      spendCents: 0,
      budgetCents: 0,
      utilizationPercent: 0,
    });
    mockCostsApi.byAgent.mockResolvedValue([]);
    mockCostsApi.byAgentModel.mockResolvedValue([]);
    mockCostsApi.byProject.mockResolvedValue([]);
    mockCostsApi.byProvider.mockResolvedValue([]);
    mockCostsApi.byBiller.mockResolvedValue([]);
    mockCostsApi.financeSummary.mockResolvedValue({
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
    mockCostsApi.financeByBiller.mockResolvedValue([]);
    mockCostsApi.financeByKind.mockResolvedValue([]);
    mockCostsApi.financeEvents.mockResolvedValue([]);
    mockCostsApi.windowSpend.mockResolvedValue([]);
    mockCostsApi.quotaWindows.mockResolvedValue([]);
    mockCostsApi.routing.mockResolvedValue(routingReport);
    mockBudgetsApi.overview.mockResolvedValue({
      companyId: "company-1",
      policies: [],
      activeIncidents: [],
      pausedAgentCount: 0,
      pausedProjectCount: 0,
      pendingApprovalCount: 0,
    });
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableProviderAuthCostInsights: false,
    });
  });

  afterEach(() => {
    if (root) flushSync(() => root?.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderCosts() {
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <Costs />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  function findRoutingTrigger() {
    return Array.from(container.querySelectorAll('[role="tab"]')).find(
      (element) => element.textContent?.trim() === "Routing",
    ) as HTMLElement | undefined;
  }

  it("offers a Routing tab alongside the existing cost tabs", async () => {
    await renderCosts();

    const labels = Array.from(container.querySelectorAll('[role="tab"]')).map((element) =>
      element.textContent?.trim(),
    );
    expect(labels).toEqual(["Overview", "Budgets", "Providers", "Billers", "Routing", "Finance"]);
  });

  it("does not fetch the routing report until the tab is selected", async () => {
    await renderCosts();

    expect(mockCostsApi.routing).not.toHaveBeenCalled();
  });

  it("loads and renders the orchestration split once the Routing tab is opened", async () => {
    await renderCosts();

    const trigger = findRoutingTrigger();
    expect(trigger).toBeDefined();
    // radix tabs activate on focus in automatic mode; mousedown drives that path
    flushSync(() => {
      trigger?.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
      trigger?.focus();
      trigger?.click();
    });
    await flushReact();

    expect(mockCostsApi.routing).toHaveBeenCalledWith(
      "company-1",
      expect.any(String),
      expect.any(String),
      25,
    );
    expect(container.textContent).toContain("Orchestration overhead");
    expect(container.textContent).toContain("PAP-42");
    expect(container.textContent).toContain("Migrate the org chart");
    expect(container.textContent).toContain("60%");
    expect(container.textContent).toContain("Orchestration-heavy");
  });
});
