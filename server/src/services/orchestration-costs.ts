import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
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
  OrchestrationCostDepth,
  OrchestrationCostMeasures,
  OrchestrationCostReport,
  OrchestrationCostTree,
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

interface GrainRow {
  grain: "tree" | "depth" | "total" | "tree_meta" | "depth_meta" | "total_meta";
  groupKey: string | null;
  runClass: OrchestrationRunClass;
  runCount: number | string | null;
  issueCount: number | string | null;
  maxRequestDepth: number | string | null;
  costCents: number | string | null;
  tokens: number | string | null;
  unpricedEventCount: number | string | null;
  subscriptionEventCount: number | string | null;
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

function finalizeMeasures(target: OrchestrationCostMeasures): void {
  target.orchestrationCostRatio = ratio(target.orchestrationCents, target.totalCents);
  target.orchestrationTokenRatio = ratio(target.orchestrationTokens, target.totalTokens);
}

/**
 * Orchestration outweighs execution on whichever basis actually has data.
 * Cents are authoritative; tokens are the fallback for subscription-billed and
 * unpriced companies, which would otherwise always read as "no overhead".
 */
function isOverheadInverted(measures: OrchestrationCostMeasures): boolean {
  if (measures.totalCents > 0) {
    return measures.orchestrationCents > measures.executionCents;
  }
  if (measures.totalTokens > 0) {
    return measures.orchestrationTokens > measures.executionTokens;
  }
  return false;
}

export function orchestrationCostService(db: Db) {
  return {
    /**
     * Aggregates every cost-bearing heartbeat run in the company into
     * orchestration / execution buckets, rolled up per root issue tree and per
     * delegation depth.
     *
     * Every query is company-scoped. The recursive walk rides
     * `issues_company_parent_idx`, and the cost scan rides
     * `cost_events_company_occurred_idx`.
     */
    report: async (
      companyId: string,
      range?: CostDateRange,
      options: OrchestrationCostOptions = {},
    ): Promise<OrchestrationCostReport> => {
      const treeLimit = clampTreeLimit(options.limit);
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

      // One round trip, six grains (tree / depth / total, each with a matching
      // meta row). The recursive CTE is expensive enough that evaluating it
      // once and fanning out with UNION ALL beats issuing separate statements.
      const reportSql = sql`
        WITH RECURSIVE issue_tree(id, root_id) AS (
          SELECT ${issues.id}, ${issues.id}
          FROM ${issues}
          WHERE ${issues.companyId} = ${companyId}
            AND ${issues.parentId} IS NULL
            AND ${issues.hiddenAt} IS NULL
            AND ${issues.harnessKind} IS NULL
          UNION ALL
          SELECT child.id, parent.root_id
          FROM ${issues} child
          JOIN issue_tree parent ON child.parent_id = parent.id
          WHERE child.company_id = ${companyId}
            AND child.hidden_at IS NULL
            AND child.harness_kind IS NULL
        ),
        scoped_events AS (
          SELECT
            ${costEvents.heartbeatRunId} AS run_id,
            ${costEvents.issueId} AS issue_id,
            issue_tree.root_id AS root_id,
            ${issues.requestDepth} AS request_depth,
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
          JOIN issue_tree ON issue_tree.id = ${costEvents.issueId}
          JOIN ${issues} ON ${issues.id} = ${costEvents.issueId} AND ${issues.companyId} = ${companyId}
          WHERE ${costEvents.companyId} = ${companyId}
            AND ${costEvents.heartbeatRunId} IS NOT NULL${fromClause}${toClause}
        ),
        classified_runs AS (
          SELECT
            distinct_runs.classified_run_id AS run_id,
            CASE
              WHEN EXISTS (
                SELECT 1 FROM ${issueWorkProducts}
                WHERE ${issueWorkProducts.companyId} = ${companyId}
                  AND ${issueWorkProducts.createdByRunId} = distinct_runs.classified_run_id
              ) OR EXISTS (
                SELECT 1 FROM ${documentRevisions}
                WHERE ${documentRevisions.companyId} = ${companyId}
                  AND ${documentRevisions.createdByRunId} = distinct_runs.classified_run_id
              ) THEN 'execution'
              WHEN EXISTS (
                SELECT 1 FROM ${issueComments}
                WHERE ${issueComments.companyId} = ${companyId}
                  AND (
                    ${issueComments.createdByRunId} = distinct_runs.classified_run_id
                    OR ${issueComments.derivedCreatedByRunId} = distinct_runs.classified_run_id
                  )
              ) OR EXISTS (
                SELECT 1 FROM ${activityLog}
                WHERE ${activityLog.companyId} = ${companyId}
                  AND ${activityLog.runId} = distinct_runs.classified_run_id
                  AND ${activityLog.action} IN (${orchestrationActionList})
              ) THEN 'orchestration'
              ELSE 'unclassified'
            END AS run_class
          -- aliased away from "run_id" on purpose: activity_log has a run_id
          -- column of its own, and an unqualified correlated reference would
          -- silently resolve to the inner table and match every row.
          FROM (SELECT DISTINCT run_id AS classified_run_id FROM scoped_events) AS distinct_runs
        ),
        events AS (
          SELECT scoped_events.*, classified_runs.run_class
          FROM scoped_events
          JOIN classified_runs ON classified_runs.run_id = scoped_events.run_id
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
          coalesce(sum(is_subscription), 0)::int AS "subscriptionEventCount"
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
          coalesce(sum(is_subscription), 0)::int
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
          coalesce(sum(is_subscription), 0)::int
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
          0
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
          0
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
          0
        FROM events
      `;

      const unattributedConditions = [
        eq(costEvents.companyId, companyId),
        isNull(costEvents.issueId),
      ];
      if (range?.from) unattributedConditions.push(gte(costEvents.occurredAt, range.from));
      if (range?.to) unattributedConditions.push(lte(costEvents.occurredAt, range.to));

      const [grainResult, unattributedRows] = await Promise.all([
        db.execute(reportSql),
        db
          .select({ eventCount: sql<number>`count(*)::int` })
          .from(costEvents)
          .where(and(...unattributedConditions)),
      ]);

      const grainRows: GrainRow[] = Array.isArray(grainResult)
        ? (grainResult as unknown as GrainRow[])
        : ((grainResult as unknown as { rows?: GrainRow[] })?.rows ?? []);

      const summary = emptyMeasures();
      let summaryIssueCount = 0;
      const treeAccumulators = new Map<
        string,
        { measures: OrchestrationCostMeasures; issueCount: number; maxRequestDepth: number }
      >();
      const depthAccumulators = new Map<
        number,
        { measures: OrchestrationCostMeasures; issueCount: number }
      >();

      const emptyTreeEntry = () => ({
        measures: emptyMeasures(),
        issueCount: 0,
        maxRequestDepth: 0,
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
          overheadInverted: isOverheadInverted(entry.measures),
        };
      });

      const invertedTreeCount = allTrees.filter((tree) => tree.overheadInverted).length;

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
          overheadInverted: tree.overheadInverted,
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
          invertedTreeCount,
          unattributedEventCount: toNumber(unattributedRows[0]?.eventCount),
          ...summary,
        },
        trees,
        byDepth,
      };
    },
  };
}
