import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  costEvents,
  documentRevisions,
  issueComments,
  issues,
  issueWorkProducts,
} from "@paperclipai/db";
import type {
  OrchestrationCostBasis,
  OrchestrationCostDepth,
  OrchestrationCostExclusions,
  OrchestrationCostMeasures,
  OrchestrationCostReport,
  OrchestrationCostTree,
  OrchestrationOverheadVerdict,
  OrchestrationRunClass,
} from "@paperclipai/shared";
import type { CostDateRange } from "./costs.js";

/**
 * Orchestration-vs-execution cost read model.
 *
 * This module answers one question: does an issue tree spend more on deciding
 * who does the work than on doing it? The agent-tiers plan states the invariant
 * as "an issue tree whose orchestration cost exceeds its execution cost is a
 * bug", so this is the instrument that makes the breach visible before tiered
 * delegation is switched on.
 *
 * It is read-only. It writes nothing and it changes no behavior.
 *
 * Three rules keep the instrument honest:
 *
 * 1. A comparison is only issued on a unit that covers every row being compared.
 *    Unpriced and subscription-billed rows are held out of the cent sums, so a
 *    group that mixes them with priced rows has no such unit and is reported
 *    `indeterminate` rather than judged on cents that ignore half the work.
 * 2. The displayed ratio and the verdict share a denominator, so a tree can
 *    never show "30% orchestration" next to an "orchestration-heavy" badge.
 * 3. Every cost event in range is accounted for: counted, or attributed to one
 *    named exclusion reason. Nothing disappears.
 */

/** cost rows with this status carry token counts but no priced amount */
const UNPRICED_COST_STATUS = "unpriced";

/**
 * Agents on this billing type report ~zero marginal cost, so including them in
 * a cents ratio makes any tree they touch look free. They are segmented out of
 * every cent sum and counted separately; their tokens still land in the token
 * sums, because quota — not dollars — is the scarce resource for them.
 */
const SUBSCRIPTION_BILLING_TYPE = "subscription_included";

/**
 * Activity-log actions that mark a run as having done org work rather than
 * product work: it split the task, talked about it, or handed it to somebody.
 */
const ORCHESTRATION_ACTIONS = [
  "issue.child_created",
  "issue.created",
  "issue.assigned",
  "issue.assignment_wakeup_requested",
  "issue.comment_added",
] as const;

/** issue statuses that mean the work is finished, one way or the other */
const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;

/**
 * Floors below which a tree is not judged at all.
 *
 * Without them every in-flight tree trips the alarm the moment a manager posts
 * its first comment and delegates: one cent of orchestration against zero cents
 * of not-yet-reported execution is technically an inversion and practically
 * noise. A dollar of classified metered spend, or a million tokens of
 * subscription work, is roughly "more than one substantial run on each side".
 */
const MIN_CLASSIFIED_CENTS = 100;
const MIN_CLASSIFIED_TOKENS = 1_000_000;

/**
 * Guard on the parent walk. Real issue trees are a handful of levels deep; this
 * only exists so a cycle introduced by a bad write cannot spin the recursion.
 * A chain that does not terminate inside the cap is reported as an
 * `unresolved_issue` exclusion rather than silently dropped.
 */
const MAX_ANCESTOR_WALK_DEPTH = 64;

const DEFAULT_TREE_LIMIT = 25;
const MAX_TREE_LIMIT = 200;

export interface OrchestrationCostOptions {
  /** how many root issue trees to return, heaviest first */
  limit?: number;
}

export function clampTreeLimit(limit?: number): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_TREE_LIMIT;
  const rounded = Math.trunc(limit);
  if (rounded <= 0) return DEFAULT_TREE_LIMIT;
  return Math.min(rounded, MAX_TREE_LIMIT);
}

type GrainName =
  | "tree"
  | "depth"
  | "total"
  | "tree_meta"
  | "depth_meta"
  | "total_meta"
  | "exclusion";

interface GrainRow {
  grain: GrainName;
  /** root issue id, request depth, or — for the `exclusion` grain — a reason */
  groupKey: string | null;
  runClass: OrchestrationRunClass;
  /** distinct runs, or — for the `exclusion` grain — a raw event count */
  runCount: number | string | null;
  issueCount: number | string | null;
  maxRequestDepth: number | string | null;
  /** priced cents, or — for the `exclusion` grain — raw `cost_cents` */
  costCents: number | string | null;
  tokens: number | string | null;
  unpricedEventCount: number | string | null;
  subscriptionEventCount: number | string | null;
  /** `tree_meta` only: the tree still has open work */
  treeOpen: boolean | null;
}

function toNumber(value: number | string | null | undefined): number {
  return Number(value ?? 0);
}

function ratio(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Number((part / total).toFixed(4));
}

function emptyMeasures(): OrchestrationCostMeasures {
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
    basis: "indeterminate",
  };
}

function emptyExclusions(): OrchestrationCostExclusions {
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
  };
}

/** folds one (grain, class) aggregate row into the running measures for its group */
function applyRow(target: OrchestrationCostMeasures, row: GrainRow): void {
  const runCount = toNumber(row.runCount);
  const cents = toNumber(row.costCents);
  const tokens = toNumber(row.tokens);

  if (row.runClass === "orchestration") {
    target.orchestrationRunCount += runCount;
    target.orchestrationCents += cents;
    target.orchestrationTokens += tokens;
  } else if (row.runClass === "execution") {
    target.executionRunCount += runCount;
    target.executionCents += cents;
    target.executionTokens += tokens;
  } else {
    target.unclassifiedRunCount += runCount;
    target.unclassifiedCents += cents;
    target.unclassifiedTokens += tokens;
  }

  target.totalCents += cents;
  target.totalTokens += tokens;
  target.unpricedEventCount += toNumber(row.unpricedEventCount);
  target.subscriptionEventCount += toNumber(row.subscriptionEventCount);
}

/**
 * The unit this group can be compared on.
 *
 * Cents only qualify when *every* row in the group is priced and metered. The
 * moment an unpriced or subscription-billed row joins a priced one, the cent
 * sums silently value that row at zero — the review case is a metered manager
 * posting a 300c orchestration run over a subscription-billed executor burning
 * 5M tokens, which reads as 100% orchestration on cents and ~2% on tokens.
 * Neither number is the answer, so the group gets no verdict.
 */
export function measureBasis(measures: OrchestrationCostMeasures): OrchestrationCostBasis {
  const heldOut = measures.unpricedEventCount > 0 || measures.subscriptionEventCount > 0;
  if (measures.totalCents > 0) return heldOut ? "indeterminate" : "cents";
  if (measures.totalTokens > 0) return "tokens";
  return "indeterminate";
}

/**
 * Ratios are orchestration's share of *classified* spend, not of total spend.
 *
 * Using the total would put unclassified spend in the denominator while the
 * inversion test ignores it, so a tree with 300c orchestration, 250c execution
 * and 450c unclassified would render "30%" beside an "orchestration-heavy"
 * badge. With this denominator the tree is inverted exactly when the ratio
 * exceeds 0.5, and the two can never disagree.
 */
function finalizeMeasures(target: OrchestrationCostMeasures): void {
  target.orchestrationCostRatio = ratio(
    target.orchestrationCents,
    target.orchestrationCents + target.executionCents,
  );
  target.orchestrationTokenRatio = ratio(
    target.orchestrationTokens,
    target.orchestrationTokens + target.executionTokens,
  );
  target.basis = measureBasis(target);
}

/**
 * Verdict on the plan §9 invariant for one tree, in precedence order: a tree
 * with no honest basis is never judged, a tree that is still running is judged
 * later, a tree that has barely spent is not worth judging, and only then does
 * the actual comparison run.
 */
export function overheadVerdict(
  measures: OrchestrationCostMeasures,
  inFlight: boolean,
): OrchestrationOverheadVerdict {
  if (measures.basis === "indeterminate") return "indeterminate";
  const onCents = measures.basis === "cents";
  const orchestration = onCents ? measures.orchestrationCents : measures.orchestrationTokens;
  const execution = onCents ? measures.executionCents : measures.executionTokens;
  const floor = onCents ? MIN_CLASSIFIED_CENTS : MIN_CLASSIFIED_TOKENS;
  if (inFlight) return "in_flight";
  if (orchestration + execution < floor) return "below_floor";
  return orchestration > execution ? "inverted" : "balanced";
}

/**
 * Builds the single statement behind the report. Exported so the plan can be
 * inspected with `EXPLAIN` without going through the service.
 *
 * Shape notes, all of them load-bearing for a large company:
 *
 * - the tree walk climbs from the cost-bearing issues to their roots rather
 *   than descending from every root in the company, so a one-day range touches
 *   the handful of issues that spent money instead of the whole issue table
 * - run classification is expressed as `UNION`-ed semi-join CTEs joined back to
 *   the distinct run list, not as `EXISTS` inside a `CASE`. Postgres cannot
 *   pull a `CASE`-embedded `EXISTS` into a semi-join, so those became
 *   correlated `SubPlan`s re-executed once per run — including a sequential
 *   scan of every comment in the company
 * - the exclusion grain re-derives the same predicates over the unfiltered
 *   event set so every dropped event is reported with a reason
 */
export function buildOrchestrationReportSql(companyId: string, range?: CostDateRange) {
  // postgres-js cannot bind a Date through a raw `sql` fragment, so the
  // bounds go over the wire as ISO text with an explicit cast.
  const fromClause = range?.from
    ? sql` AND ${costEvents.occurredAt} >= ${range.from.toISOString()}::timestamptz`
    : sql``;
  const toClause = range?.to
    ? sql` AND ${costEvents.occurredAt} <= ${range.to.toISOString()}::timestamptz`
    : sql``;

  const orchestrationActionList = sql.join(
    ORCHESTRATION_ACTIONS.map((action) => sql`${action}`),
    sql`, `,
  );
  const terminalStatusList = sql.join(
    TERMINAL_ISSUE_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );

  return sql`
    WITH RECURSIVE range_events AS (
      SELECT
        ${costEvents.issueId} AS issue_id,
        ${costEvents.heartbeatRunId} AS run_id,
        ${costEvents.costCents} AS raw_cents,
        CASE
          WHEN ${costEvents.costStatus} = ${UNPRICED_COST_STATUS}
            OR ${costEvents.billingType} = ${SUBSCRIPTION_BILLING_TYPE}
          THEN 0
          ELSE ${costEvents.costCents}
        END AS priced_cents,
        (${costEvents.inputTokens} + ${costEvents.cachedInputTokens} + ${costEvents.outputTokens}) AS tokens,
        CASE WHEN ${costEvents.costStatus} = ${UNPRICED_COST_STATUS} THEN 1 ELSE 0 END AS is_unpriced,
        CASE WHEN ${costEvents.billingType} = ${SUBSCRIPTION_BILLING_TYPE} THEN 1 ELSE 0 END AS is_subscription
      FROM ${costEvents}
      WHERE ${costEvents.companyId} = ${companyId}${fromClause}${toClause}
    ),
    attributable AS (
      SELECT
        range_events.issue_id,
        range_events.run_id,
        range_events.priced_cents,
        range_events.tokens,
        range_events.is_unpriced,
        range_events.is_subscription,
        ${issues.requestDepth} AS request_depth,
        (${issues.status} NOT IN (${terminalStatusList})) AS issue_open
      FROM range_events
      JOIN ${issues}
        ON ${issues.id} = range_events.issue_id
       AND ${issues.companyId} = ${companyId}
      WHERE range_events.issue_id IS NOT NULL
        AND range_events.run_id IS NOT NULL
    ),
    -- climb from each cost-bearing issue to its root, carrying forward whether
    -- anything on the path is hidden or harness-scoped. The old shape walked
    -- down from every root in the company and had no date bound at all.
    ancestry AS (
      SELECT
        seed.issue_id AS issue_id,
        anchor.id AS node_id,
        anchor.parent_id AS parent_id,
        (anchor.hidden_at IS NOT NULL OR anchor.harness_kind IS NOT NULL) AS blocked,
        0 AS walk_depth
      FROM (SELECT DISTINCT issue_id FROM attributable) AS seed
      JOIN ${issues} anchor
        ON anchor.id = seed.issue_id
       AND anchor.company_id = ${companyId}
      UNION ALL
      SELECT
        ancestry.issue_id,
        parent.id,
        parent.parent_id,
        ancestry.blocked OR (parent.hidden_at IS NOT NULL OR parent.harness_kind IS NOT NULL),
        ancestry.walk_depth + 1
      FROM ancestry
      JOIN ${issues} parent
        ON parent.id = ancestry.parent_id
       AND parent.company_id = ${companyId}
      WHERE ancestry.walk_depth < ${MAX_ANCESTOR_WALK_DEPTH}
    ),
    issue_root AS (
      SELECT issue_id, node_id AS root_id, blocked
      FROM ancestry
      WHERE parent_id IS NULL
    ),
    root_state AS (
      SELECT
        roots.root_id,
        (root_issue.status NOT IN (${terminalStatusList})) AS root_open
      FROM (SELECT DISTINCT root_id FROM issue_root WHERE blocked = false) AS roots
      JOIN ${issues} root_issue
        ON root_issue.id = roots.root_id
       AND root_issue.company_id = ${companyId}
    ),
    tree_events AS (
      SELECT
        attributable.*,
        issue_root.root_id,
        coalesce(root_state.root_open, false) AS root_open
      FROM attributable
      JOIN issue_root
        ON issue_root.issue_id = attributable.issue_id
       AND issue_root.blocked = false
      LEFT JOIN root_state ON root_state.root_id = issue_root.root_id
    ),
    distinct_runs AS (SELECT DISTINCT run_id FROM tree_events),
    -- semi-joins, not correlated EXISTS: each of these is one indexed lookup
    -- per candidate run at worst, and the planner is free to hash them.
    execution_runs AS (
      SELECT work_product.created_by_run_id AS run_id
      FROM ${issueWorkProducts} work_product
      JOIN distinct_runs ON distinct_runs.run_id = work_product.created_by_run_id
      WHERE work_product.company_id = ${companyId}
      UNION
      SELECT revision.created_by_run_id
      FROM ${documentRevisions} revision
      JOIN distinct_runs ON distinct_runs.run_id = revision.created_by_run_id
      WHERE revision.company_id = ${companyId}
    ),
    orchestration_runs AS (
      SELECT comment.created_by_run_id AS run_id
      FROM ${issueComments} comment
      JOIN distinct_runs ON distinct_runs.run_id = comment.created_by_run_id
      WHERE comment.company_id = ${companyId}
      UNION
      SELECT comment.derived_created_by_run_id
      FROM ${issueComments} comment
      JOIN distinct_runs ON distinct_runs.run_id = comment.derived_created_by_run_id
      WHERE comment.company_id = ${companyId}
      UNION
      SELECT entry.run_id
      FROM ${activityLog} entry
      JOIN distinct_runs ON distinct_runs.run_id = entry.run_id
      WHERE entry.company_id = ${companyId}
        AND entry.action IN (${orchestrationActionList})
    ),
    events AS (
      SELECT
        tree_events.*,
        CASE
          WHEN execution_runs.run_id IS NOT NULL THEN 'execution'
          WHEN orchestration_runs.run_id IS NOT NULL THEN 'orchestration'
          ELSE 'unclassified'
        END AS run_class
      FROM tree_events
      LEFT JOIN execution_runs ON execution_runs.run_id = tree_events.run_id
      LEFT JOIN orchestration_runs ON orchestration_runs.run_id = tree_events.run_id
    ),
    -- the same predicates, in the same order, over every event in range, so
    -- each one is either counted or attributed to a named drop reason
    exclusions AS (
      SELECT
        CASE
          WHEN range_events.issue_id IS NULL THEN 'no_issue'
          WHEN range_events.run_id IS NULL THEN 'no_run'
          WHEN issue_root.issue_id IS NULL THEN 'unresolved_issue'
          WHEN issue_root.blocked THEN 'hidden_tree'
          WHEN range_events.is_unpriced = 1 OR range_events.is_subscription = 1
            THEN 'counted_held_out'
          ELSE 'counted_priced'
        END AS reason,
        range_events.raw_cents
      FROM range_events
      LEFT JOIN issue_root ON issue_root.issue_id = range_events.issue_id
    )
    SELECT
      'tree' AS "grain",
      root_id::text AS "groupKey",
      run_class AS "runClass",
      count(DISTINCT run_id)::int AS "runCount",
      count(DISTINCT issue_id)::int AS "issueCount",
      coalesce(max(request_depth), 0)::int AS "maxRequestDepth",
      coalesce(sum(priced_cents), 0)::double precision AS "costCents",
      coalesce(sum(tokens), 0)::double precision AS "tokens",
      coalesce(sum(is_unpriced), 0)::int AS "unpricedEventCount",
      coalesce(sum(is_subscription), 0)::int AS "subscriptionEventCount",
      false AS "treeOpen"
    FROM events
    GROUP BY root_id, run_class
    UNION ALL
    SELECT
      'depth',
      request_depth::text,
      run_class,
      count(DISTINCT run_id)::int,
      count(DISTINCT issue_id)::int,
      coalesce(max(request_depth), 0)::int,
      coalesce(sum(priced_cents), 0)::double precision,
      coalesce(sum(tokens), 0)::double precision,
      coalesce(sum(is_unpriced), 0)::int,
      coalesce(sum(is_subscription), 0)::int,
      false
    FROM events
    GROUP BY request_depth, run_class
    UNION ALL
    SELECT
      'total',
      NULL,
      run_class,
      count(DISTINCT run_id)::int,
      count(DISTINCT issue_id)::int,
      coalesce(max(request_depth), 0)::int,
      coalesce(sum(priced_cents), 0)::double precision,
      coalesce(sum(tokens), 0)::double precision,
      coalesce(sum(is_unpriced), 0)::int,
      coalesce(sum(is_subscription), 0)::int,
      false
    FROM events
    GROUP BY run_class
    -- distinct issue counts must not be partitioned by run class, or an
    -- issue whose runs land in two classes is counted twice. These meta
    -- rows carry counts only; every measure column is zero.
    UNION ALL
    SELECT
      'tree_meta',
      root_id::text,
      'unclassified',
      0,
      count(DISTINCT issue_id)::int,
      coalesce(max(request_depth), 0)::int,
      0::double precision,
      0::double precision,
      0,
      0,
      bool_or(issue_open OR root_open)
    FROM events
    GROUP BY root_id
    UNION ALL
    SELECT
      'depth_meta',
      request_depth::text,
      'unclassified',
      0,
      count(DISTINCT issue_id)::int,
      coalesce(max(request_depth), 0)::int,
      0::double precision,
      0::double precision,
      0,
      0,
      false
    FROM events
    GROUP BY request_depth
    UNION ALL
    SELECT
      'total_meta',
      NULL,
      'unclassified',
      0,
      count(DISTINCT issue_id)::int,
      coalesce(max(request_depth), 0)::int,
      0::double precision,
      0::double precision,
      0,
      0,
      false
    FROM events
    UNION ALL
    SELECT
      'exclusion',
      reason,
      'unclassified',
      count(*)::int,
      0,
      0,
      coalesce(sum(raw_cents), 0)::double precision,
      0::double precision,
      0,
      0,
      false
    FROM exclusions
    GROUP BY reason
  `;
}

export function orchestrationCostService(db: Db) {
  return {
    /**
     * Aggregates every cost-bearing heartbeat run in the company into
     * orchestration / execution buckets, rolled up per root issue tree and per
     * delegation depth.
     *
     * Every query is company-scoped. The event scan rides
     * `cost_events_company_occurred_idx`, the ancestor walk rides the issues
     * primary key, and run classification rides the
     * `*_company_created_by_run_idx` indexes.
     */
    report: async (
      companyId: string,
      range?: CostDateRange,
      options: OrchestrationCostOptions = {},
    ): Promise<OrchestrationCostReport> => {
      const treeLimit = clampTreeLimit(options.limit);
      const grainResult = await db.execute(buildOrchestrationReportSql(companyId, range));

      const grainRows: GrainRow[] = Array.isArray(grainResult)
        ? (grainResult as unknown as GrainRow[])
        : ((grainResult as unknown as { rows?: GrainRow[] })?.rows ?? []);

      const summary = emptyMeasures();
      const exclusions = emptyExclusions();
      let summaryIssueCount = 0;
      const treeAccumulators = new Map<
        string,
        {
          measures: OrchestrationCostMeasures;
          issueCount: number;
          maxRequestDepth: number;
          inFlight: boolean;
        }
      >();
      const depthAccumulators = new Map<
        number,
        { measures: OrchestrationCostMeasures; issueCount: number }
      >();

      const emptyTreeEntry = () => ({
        measures: emptyMeasures(),
        issueCount: 0,
        maxRequestDepth: 0,
        inFlight: false,
      });
      const emptyDepthEntry = () => ({ measures: emptyMeasures(), issueCount: 0 });

      for (const row of grainRows) {
        switch (row.grain) {
          case "total":
            applyRow(summary, row);
            break;
          case "total_meta":
            summaryIssueCount = toNumber(row.issueCount);
            break;
          case "exclusion": {
            const eventCount = toNumber(row.runCount);
            const rawCents = toNumber(row.costCents);
            exclusions.totalEventCount += eventCount;
            exclusions.totalCostCents += rawCents;
            switch (row.groupKey) {
              case "no_issue":
                exclusions.noIssueEventCount = eventCount;
                exclusions.noIssueCostCents = rawCents;
                break;
              case "no_run":
                exclusions.noRunEventCount = eventCount;
                exclusions.noRunCostCents = rawCents;
                break;
              case "unresolved_issue":
                exclusions.unresolvedIssueEventCount = eventCount;
                exclusions.unresolvedIssueCostCents = rawCents;
                break;
              case "hidden_tree":
                exclusions.hiddenTreeEventCount = eventCount;
                exclusions.hiddenTreeCostCents = rawCents;
                break;
              case "counted_held_out":
                exclusions.countedEventCount += eventCount;
                exclusions.countedCostCents += rawCents;
                exclusions.heldOutCostCents += rawCents;
                break;
              default:
                exclusions.countedEventCount += eventCount;
                exclusions.countedCostCents += rawCents;
                break;
            }
            break;
          }
          case "tree":
          case "tree_meta": {
            const key = row.groupKey ?? "";
            if (!key) break;
            const entry = treeAccumulators.get(key) ?? emptyTreeEntry();
            if (row.grain === "tree") {
              applyRow(entry.measures, row);
            } else {
              entry.issueCount = toNumber(row.issueCount);
              entry.maxRequestDepth = toNumber(row.maxRequestDepth);
              entry.inFlight = row.treeOpen === true;
            }
            treeAccumulators.set(key, entry);
            break;
          }
          default: {
            const depth = toNumber(row.groupKey);
            const entry = depthAccumulators.get(depth) ?? emptyDepthEntry();
            if (row.grain === "depth") {
              applyRow(entry.measures, row);
            } else {
              entry.issueCount = toNumber(row.issueCount);
            }
            depthAccumulators.set(depth, entry);
            break;
          }
        }
      }

      finalizeMeasures(summary);

      const allTrees = Array.from(treeAccumulators.entries()).map(([rootIssueId, entry]) => {
        finalizeMeasures(entry.measures);
        return {
          rootIssueId,
          issueCount: entry.issueCount,
          maxRequestDepth: entry.maxRequestDepth,
          measures: entry.measures,
          inFlight: entry.inFlight,
          overheadVerdict: overheadVerdict(entry.measures, entry.inFlight),
        };
      });

      const invertedTreeCount = allTrees.filter(
        (tree) => tree.overheadVerdict === "inverted",
      ).length;
      const judgedTreeCount = allTrees.filter(
        (tree) => tree.overheadVerdict === "inverted" || tree.overheadVerdict === "balanced",
      ).length;

      allTrees.sort((a, b) => {
        if (b.measures.totalCents !== a.measures.totalCents) {
          return b.measures.totalCents - a.measures.totalCents;
        }
        if (b.measures.totalTokens !== a.measures.totalTokens) {
          return b.measures.totalTokens - a.measures.totalTokens;
        }
        return a.rootIssueId.localeCompare(b.rootIssueId);
      });

      const topTrees = allTrees.slice(0, treeLimit);
      const rootIds = topTrees.map((tree) => tree.rootIssueId);

      // Company-scoped label lookup for the trees that survived the cap only.
      const rootIssueRows = rootIds.length
        ? await db
            .select({
              id: issues.id,
              identifier: issues.identifier,
              title: issues.title,
            })
            .from(issues)
            .where(and(eq(issues.companyId, companyId), inArray(issues.id, rootIds)))
        : [];
      const rootIssueById = new Map(rootIssueRows.map((row) => [row.id, row]));

      const trees: OrchestrationCostTree[] = topTrees.map((tree) => {
        const issue = rootIssueById.get(tree.rootIssueId);
        return {
          rootIssueId: tree.rootIssueId,
          rootIssueIdentifier: issue?.identifier ?? null,
          rootIssueTitle: issue?.title ?? null,
          issueCount: tree.issueCount,
          maxRequestDepth: tree.maxRequestDepth,
          inFlight: tree.inFlight,
          overheadVerdict: tree.overheadVerdict,
          ...tree.measures,
        };
      });

      const byDepth: OrchestrationCostDepth[] = Array.from(depthAccumulators.entries())
        .map(([requestDepth, entry]) => {
          finalizeMeasures(entry.measures);
          return { requestDepth, issueCount: entry.issueCount, ...entry.measures };
        })
        .sort((a, b) => a.requestDepth - b.requestDepth);

      return {
        summary: {
          companyId,
          issueCount: summaryIssueCount,
          treeCount: allTrees.length,
          judgedTreeCount,
          invertedTreeCount,
          exclusions,
          ...summary,
        },
        trees,
        byDepth,
        thresholds: {
          minClassifiedCents: MIN_CLASSIFIED_CENTS,
          minClassifiedTokens: MIN_CLASSIFIED_TOKENS,
        },
      };
    },
  };
}
