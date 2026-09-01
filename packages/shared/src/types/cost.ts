import type {
  BillingType,
  CostStatus,
  ORCHESTRATION_COST_BASES,
  ORCHESTRATION_COST_EXCLUSION_REASONS,
  ORCHESTRATION_OVERHEAD_VERDICTS,
  ORCHESTRATION_RUN_CLASSES,
} from "../constants.js";

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
 * Which unit a group's orchestration-vs-execution comparison is read on. Ships
 * on the wire so a consumer can never confuse a cents verdict with a tokens
 * verdict, and never renders a verdict for a group that has neither.
 */
export type OrchestrationCostBasis = (typeof ORCHESTRATION_COST_BASES)[number];

/** verdict on the orchestration-vs-execution invariant for one issue tree */
export type OrchestrationOverheadVerdict = (typeof ORCHESTRATION_OVERHEAD_VERDICTS)[number];

/** why a cost event in range never reached an issue tree */
export type OrchestrationCostExclusionReason =
  (typeof ORCHESTRATION_COST_EXCLUSION_REASONS)[number];

/**
 * Measures shared by every grain of the orchestration cost report.
 *
 * `*Cents` values come from priced, metered rows only: `costStatus: "unpriced"`
 * rows and `billingType: "subscription_included"` rows are excluded because
 * neither carries a marginal dollar cost that can be compared. `*Tokens` values
 * include every row, so subscription-billed agents still produce a usable
 * quota-shaped ratio.
 *
 * Because those two exclusions zero out a row's cents while keeping its tokens,
 * a group that mixes priced and held-out rows has no single unit that covers all
 * of its work. `basis` says which unit — if any — the group can be judged on;
 * never compare `*Cents` against `*Tokens`, and never read a ratio without it.
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
  /**
   * `orchestrationCents / (orchestrationCents + executionCents)`, rounded to
   * 4 dp; null when nothing is classified. The denominator deliberately excludes
   * unclassified spend so that this ratio and the inversion verdict can never
   * disagree: the tree is inverted exactly when this exceeds 0.5.
   */
  orchestrationCostRatio: number | null;
  /** `orchestrationTokens / (orchestrationTokens + executionTokens)`, same rule */
  orchestrationTokenRatio: number | null;
  /** cost rows dropped from the cent sums because they are unpriced */
  unpricedEventCount: number;
  /** cost rows dropped from the cent sums because the agent is subscription-billed */
  subscriptionEventCount: number;
  /** unit this group can be compared on; `indeterminate` means it cannot be */
  basis: OrchestrationCostBasis;
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
  /** the tree's root, or an issue in it that carried cost, is not done or cancelled */
  inFlight: boolean;
  /**
   * Verdict on the invariant from the agent-tiers plan §9. Only `inverted`
   * means "orchestration cost exceeds execution cost"; the other values say why
   * no verdict was issued, so a caller never has to guess whether a `false`
   * meant "healthy" or "unknowable".
   */
  overheadVerdict: OrchestrationOverheadVerdict;
}

/** cost split by delegation depth, taken straight from `issues.requestDepth` */
export interface OrchestrationCostDepth extends OrchestrationCostMeasures {
  requestDepth: number;
  issueCount: number;
}

/**
 * Full accounting for every company cost event in range, so the difference
 * between this report and the Overview total is always explainable.
 *
 * `totalEventCount` and `totalCostCents` cover every cost event for the company
 * in range with no visibility filter at all, which is exactly what
 * `GET /costs/summary` reports. The four exclusion reasons are mutually
 * exclusive and, with the counted rows, sum back to those totals.
 */
export interface OrchestrationCostExclusions {
  /** every company cost event in range, before any exclusion */
  totalEventCount: number;
  /** raw `costCents` over those events — matches the Overview spend total */
  totalCostCents: number;
  /** events that reached a tree and are aggregated into the measures above */
  countedEventCount: number;
  /** raw `costCents` over counted events */
  countedCostCents: number;
  /**
   * raw `costCents` of counted events that were nevertheless held out of every
   * cent sum because they are unpriced or subscription-billed. This is the rest
   * of the gap between `countedCostCents` and `summary.totalCents`.
   */
  heldOutCostCents: number;
  /** dropped: the event carries no `issueId`, so it belongs to no tree */
  noIssueEventCount: number;
  noIssueCostCents: number;
  /** dropped: the event has an issue but no `heartbeatRunId`, so no run to classify */
  noRunEventCount: number;
  noRunCostCents: number;
  /**
   * dropped: the issue row is missing, belongs to another company, or its parent
   * chain never terminated within the ancestor walk cap
   */
  unresolvedIssueEventCount: number;
  unresolvedIssueCostCents: number;
  /**
   * dropped: the issue or one of its ancestors is hidden or harness-scoped.
   * Status cards and summary slots create hidden, agent-executed, cost-bearing
   * issues by design, so this is routinely non-zero.
   */
  hiddenTreeEventCount: number;
  hiddenTreeCostCents: number;
}

export interface OrchestrationCostSummary extends OrchestrationCostMeasures {
  companyId: string;
  issueCount: number;
  /** root trees with attributed spend in range, before the response cap */
  treeCount: number;
  /** trees that had an honest basis, cleared the spend floor, and had settled */
  judgedTreeCount: number;
  /** judged trees whose orchestration cost exceeds their execution cost */
  invertedTreeCount: number;
  /** full drop accounting for the range; nothing leaves the report silently */
  exclusions: OrchestrationCostExclusions;
}

export interface OrchestrationCostReport {
  summary: OrchestrationCostSummary;
  /** heaviest trees first, capped by the request `limit` */
  trees: OrchestrationCostTree[];
  /** ascending by `requestDepth` */
  byDepth: OrchestrationCostDepth[];
  /** spend floors below which a tree is reported `below_floor` rather than judged */
  thresholds: {
    minClassifiedCents: number;
    minClassifiedTokens: number;
  };
}
