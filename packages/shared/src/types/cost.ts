import type { BillingType, CostStatus, ORCHESTRATION_RUN_CLASSES } from "../constants.js";

export interface CostEvent {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  heartbeatRunId: string | null;
  billingCode: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  costStatus: CostStatus;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: Date;
  createdAt: Date;
}

export interface CostSummary {
  companyId: string;
  spendCents: number;
  budgetCents: number;
  utilizationPercent: number;
}

export interface IssueCostSummary {
  issueId: string;
  issueCount: number;
  includeDescendants: boolean;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** number of distinct heartbeat runs aggregated across the issue tree */
  runCount: number;
  /** sum of wall-clock duration of each run in the tree (ms);
   * still-running runs contribute (now - startedAt) so this ticks up live */
  runtimeMs: number;
}

export interface CostByAgent {
  agentId: string;
  agentName: string | null;
  agentStatus: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByProviderModel {
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByBiller {
  biller: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
  providerCount: number;
  modelCount: number;
}

/** per-agent breakdown by provider + model, for identifying token-hungry agents */
export interface CostByAgentModel {
  agentId: string;
  agentName: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** spend per provider for a fixed rolling time window */
export interface CostWindowSpendRow {
  provider: string;
  biller: string;
  /** duration label, e.g. "5h", "24h", "7d" */
  window: string;
  /** rolling window duration in hours */
  windowHours: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** cost attributed to a project via heartbeat run → activity log → issue → project chain */
export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * How a heartbeat run that carried cost is classified for the orchestration
 * overhead read model.
 *
 * - `execution`   — the run produced a work product or a document revision
 * - `orchestration` — the run only created child issues, commented, or reassigned
 * - `unclassified` — the run left none of those traces
 */
export type OrchestrationRunClass = (typeof ORCHESTRATION_RUN_CLASSES)[number];

/**
 * Measures shared by every grain of the orchestration cost report.
 *
 * `*Cents` values come from priced, metered rows only: `costStatus: "unpriced"`
 * rows and `billingType: "subscription_included"` rows are excluded because
 * neither carries a marginal dollar cost that can be compared. `*Tokens` values
 * include every row, so subscription-billed agents still produce a usable
 * quota-shaped ratio.
 */
export interface OrchestrationCostMeasures {
  orchestrationRunCount: number;
  executionRunCount: number;
  unclassifiedRunCount: number;
  orchestrationCents: number;
  executionCents: number;
  unclassifiedCents: number;
  totalCents: number;
  orchestrationTokens: number;
  executionTokens: number;
  unclassifiedTokens: number;
  totalTokens: number;
  /** `orchestrationCents / totalCents`, rounded to 4 dp; null when totalCents is 0 */
  orchestrationCostRatio: number | null;
  /** `orchestrationTokens / totalTokens`, rounded to 4 dp; null when totalTokens is 0 */
  orchestrationTokenRatio: number | null;
  /** cost rows dropped from the cent sums because they are unpriced */
  unpricedEventCount: number;
  /** cost rows dropped from the cent sums because the agent is subscription-billed */
  subscriptionEventCount: number;
}

/** one root issue tree, aggregated over every descendant issue that carried cost */
export interface OrchestrationCostTree extends OrchestrationCostMeasures {
  rootIssueId: string;
  rootIssueIdentifier: string | null;
  rootIssueTitle: string | null;
  /** issues inside the tree that carried at least one cost event */
  issueCount: number;
  /** deepest `issues.requestDepth` seen inside the tree */
  maxRequestDepth: number;
  /**
   * true when orchestration outweighs execution on the basis that has data —
   * cents when priced metered rows exist, otherwise tokens. This is the
   * invariant breach described in the agent-tiers plan §9.
   */
  overheadInverted: boolean;
}

/** cost split by delegation depth, taken straight from `issues.requestDepth` */
export interface OrchestrationCostDepth extends OrchestrationCostMeasures {
  requestDepth: number;
  issueCount: number;
}

export interface OrchestrationCostSummary extends OrchestrationCostMeasures {
  companyId: string;
  issueCount: number;
  /** trees whose orchestration cost exceeds their execution cost */
  invertedTreeCount: number;
  /** cost events in range that carry no issue attribution and are therefore unranked */
  unattributedEventCount: number;
}

export interface OrchestrationCostReport {
  summary: OrchestrationCostSummary;
  /** heaviest trees first, capped by the request `limit` */
  trees: OrchestrationCostTree[];
  /** ascending by `requestDepth` */
  byDepth: OrchestrationCostDepth[];
}
