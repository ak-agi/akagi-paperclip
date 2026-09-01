import type {
  OrchestrationCostBasis,
  OrchestrationCostExclusions,
  OrchestrationCostMeasures,
  OrchestrationCostReport,
  OrchestrationCostTree,
} from "@paperclipai/shared";
import { AlertTriangle, GitBranch, Network } from "lucide-react";
import { EmptyState } from "./EmptyState";
import { cn, formatCents, formatTokens } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Orchestration overhead readout for the Costs → Routing tab.
 *
 * Cents are shown for priced, metered rows only. Unpriced rows carry no amount,
 * and subscription-billed agents report ~zero marginal cost, so both are held
 * out of the cent sums and reported as footnotes. Tokens include every row.
 *
 * Because those two units cover different subsets of the work, the server ships
 * a `basis` for every group saying which one — if either — that group can be
 * compared on. This component never picks a unit itself: an `indeterminate`
 * group shows its raw numbers and no verdict, so a cents verdict and a tokens
 * verdict can never be rendered the same way.
 */

export function formatRatio(value: number | null): string {
  if (value == null) return "—";
  return `${Math.round(value * 100)}%`;
}

/** the ratio that matches the group's basis, or null when it has none */
export function basisRatio(measures: OrchestrationCostMeasures): number | null {
  if (measures.basis === "cents") return measures.orchestrationCostRatio;
  if (measures.basis === "tokens") return measures.orchestrationTokenRatio;
  return null;
}

const BASIS_NOTE: Record<OrchestrationCostBasis, string> = {
  cents: "Measured on priced, metered spend",
  tokens: "Measured on tokens — no priced spend in range",
  indeterminate: "Not comparable — priced and held-out rows are mixed",
};

/**
 * Split shares for the meter. An indeterminate group is drawn on tokens, the
 * only unit every row contributes to, so the bar still shows the shape of the
 * work; the absent ratio and the absent badge carry the "no verdict" message.
 */
function splitParts(measures: OrchestrationCostMeasures) {
  const onCents = measures.basis === "cents";
  return {
    orchestration: onCents ? measures.orchestrationCents : measures.orchestrationTokens,
    execution: onCents ? measures.executionCents : measures.executionTokens,
    unclassified: onCents ? measures.unclassifiedCents : measures.unclassifiedTokens,
  };
}

/**
 * Part-to-whole split meter. Achromatic on purpose: a single-hue lightness ramp
 * is legible for every kind of color vision, and each segment is direct-labeled
 * below so identity is never carried by fill alone.
 */
function SplitMeter({
  orchestration,
  execution,
  unclassified,
  label,
}: {
  orchestration: number;
  execution: number;
  unclassified: number;
  label: string;
}) {
  const total = orchestration + execution + unclassified;
  const pct = (part: number) => (total > 0 ? (part / total) * 100 : 0);
  return (
    <div
      className="flex h-2 w-full overflow-hidden rounded-full bg-muted/70"
      role="img"
      aria-label={label}
    >
      <div className="h-full bg-foreground/75" style={{ width: `${pct(orchestration)}%` }} />
      {orchestration > 0 && execution > 0 ? <div className="h-full w-0.5 bg-card" /> : null}
      <div className="h-full bg-foreground/30" style={{ width: `${pct(execution)}%` }} />
      {execution > 0 && unclassified > 0 ? <div className="h-full w-0.5 bg-card" /> : null}
      <div className="h-full bg-muted-foreground/25" style={{ width: `${pct(unclassified)}%` }} />
    </div>
  );
}

function MeterLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full bg-foreground/75" />
        Orchestration
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full bg-foreground/30" />
        Execution
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/25" />
        Unclassified
      </span>
    </div>
  );
}

function InvertedBadge() {
  return (
    <Badge variant="destructive" className="gap-1">
      <AlertTriangle className="h-3 w-3" />
      Orchestration-heavy
    </Badge>
  );
}

/**
 * Why a tree carries no verdict. Deliberately muted: "we did not judge this"
 * must not read like "this is broken".
 */
function VerdictNote({ tree }: { tree: OrchestrationCostTree }) {
  if (tree.overheadVerdict === "inverted") return <InvertedBadge />;
  if (tree.overheadVerdict === "balanced") return null;
  const label =
    tree.overheadVerdict === "in_flight"
      ? "Still in flight"
      : tree.overheadVerdict === "below_floor"
        ? "Below the spend floor"
        : "Not comparable";
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {label}
    </Badge>
  );
}

function MeasureCell({ measures }: { measures: OrchestrationCostMeasures }) {
  const primary = formatRatio(basisRatio(measures));
  const secondary =
    measures.basis === "tokens"
      ? `${formatTokens(measures.orchestrationTokens)} of ${formatTokens(measures.orchestrationTokens + measures.executionTokens)} tokens`
      : measures.basis === "cents"
        ? `${formatCents(measures.orchestrationCents)} of ${formatCents(measures.orchestrationCents + measures.executionCents)}`
        : `${formatCents(measures.totalCents)} priced · ${formatTokens(measures.totalTokens)} tok`;
  return (
    <div className="min-w-0">
      <div className="font-medium tabular-nums">{primary}</div>
      <div className="font-mono text-xs text-muted-foreground">{secondary}</div>
    </div>
  );
}

/**
 * Full drop accounting. Every cost event in the range is either counted here or
 * named as an exclusion, so a gap against the Overview total is always
 * explainable rather than a silent disappearance.
 */
function ExclusionNote({ exclusions }: { exclusions: OrchestrationCostExclusions }) {
  const reasons: Array<[number, string]> = [
    [exclusions.noIssueEventCount, "no issue"],
    [exclusions.noRunEventCount, "no run"],
    [exclusions.hiddenTreeEventCount, "hidden issue tree"],
    [exclusions.unresolvedIssueEventCount, "unresolved issue"],
  ];
  const present = reasons.filter(([count]) => count > 0);
  const droppedCents =
    exclusions.totalCostCents - exclusions.countedCostCents;
  if (present.length === 0 && exclusions.heldOutCostCents === 0) return null;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {present.length > 0 ? (
        <p>
          {present.reduce((sum, [count]) => sum + count, 0)} of {exclusions.totalEventCount} cost
          events in range ({formatCents(droppedCents)}) are not ranked below:{" "}
          {present.map(([count, label]) => `${count} ${label}`).join(" · ")}.
        </p>
      ) : null}
      {exclusions.heldOutCostCents > 0 ? (
        <p>
          A further {formatCents(exclusions.heldOutCostCents)} of counted spend is unpriced or
          subscription-billed and is held out of every cent figure above.
        </p>
      ) : null}
    </div>
  );
}

export function CostRoutingCard({ report }: { report: OrchestrationCostReport }) {
  const { summary, trees, byDepth, thresholds } = report;
  const headlineRatio = formatRatio(basisRatio(summary));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="text-base">Orchestration overhead</CardTitle>
              <CardDescription>
                Share of classified spend that went into delegating work rather than doing it. Runs
                that produced a work product or a document revision count as execution. Runs that
                only created child issues, commented, or reassigned count as orchestration.
              </CardDescription>
            </div>
            {summary.invertedTreeCount > 0 ? <InvertedBadge /> : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-5 pb-5 pt-2">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                Orchestration share
              </div>
              <div className="mt-2 text-2xl font-semibold tabular-nums">{headlineRatio}</div>
              <div className="mt-1 text-xs text-muted-foreground">{BASIS_NOTE[summary.basis]}</div>
            </div>
            <div>
              <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                Orchestration runs
              </div>
              <div className="mt-2 text-2xl font-semibold tabular-nums">{summary.orchestrationRunCount}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {summary.executionRunCount} execution · {summary.unclassifiedRunCount} unclassified
              </div>
            </div>
            <div>
              <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                Inverted trees
              </div>
              <div className="mt-2 text-2xl font-semibold tabular-nums">
                {summary.invertedTreeCount}
                <span className="text-base font-normal text-muted-foreground">
                  /{summary.judgedTreeCount}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Of {summary.judgedTreeCount} judged tree
                {summary.judgedTreeCount === 1 ? "" : "s"}
                {summary.treeCount > summary.judgedTreeCount ? (
                  <>
                    {" "}
                    — {summary.treeCount - summary.judgedTreeCount} not judged: still in flight,
                    below {formatCents(thresholds.minClassifiedCents)}, or not comparable
                  </>
                ) : null}
              </div>
            </div>
            <div>
              <div className="text-(length:--text-micro) uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
                Held out of cost
              </div>
              <div className="mt-2 text-2xl font-semibold tabular-nums">
                {summary.unpricedEventCount + summary.subscriptionEventCount}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {summary.unpricedEventCount} unpriced · {summary.subscriptionEventCount} subscription
              </div>
            </div>
          </div>

          <SplitMeter
            label={`Company split: ${headlineRatio} orchestration`}
            {...splitParts(summary)}
          />
          <MeterLegend />

          <ExclusionNote exclusions={summary.exclusions} />
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-(--gtc-31)">
        <Card>
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle className="text-base">By issue tree</CardTitle>
            <CardDescription>
              Root issues ranked by total attributed spend. A settled issue tree whose orchestration
              cost exceeds its execution cost is a bug.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-2">
            {trees.length === 0 ? (
              <EmptyState
                icon={Network}
                message="No attributed spend yet"
                description="Cost events are grouped by root issue once agents run against issues in this range."
              />
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-accent/20 text-left text-muted-foreground">
                    <th className="px-2 py-1.5 font-medium">Root issue</th>
                    <th className="px-2 py-1.5 font-medium">Split</th>
                    <th className="px-2 py-1.5 font-medium">Orchestration</th>
                    <th className="px-2 py-1.5 text-right font-medium">Runs</th>
                    <th className="px-2 py-1.5 text-right font-medium">Depth</th>
                  </tr>
                </thead>
                <tbody>
                  {trees.map((tree) => (
                    <tr key={tree.rootIssueId} className="border-b border-border last:border-0">
                      <td className="max-w-0 px-2 py-2 align-top">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-muted-foreground">
                            {tree.rootIssueIdentifier ?? tree.rootIssueId.slice(0, 8)}
                          </span>
                          <VerdictNote tree={tree} />
                        </div>
                        <div className="truncate text-muted-foreground">
                          {tree.rootIssueTitle ?? "Untitled"}
                        </div>
                      </td>
                      <td className="w-32 px-2 py-2 align-top">
                        <SplitMeter
                          label={`${tree.rootIssueIdentifier ?? "Tree"} split`}
                          {...splitParts(tree)}
                        />
                      </td>
                      <td className="px-2 py-2 align-top">
                        <MeasureCell measures={tree} />
                      </td>
                      <td className="px-2 py-2 text-right align-top font-mono tabular-nums">
                        {tree.orchestrationRunCount}/{tree.orchestrationRunCount + tree.executionRunCount + tree.unclassifiedRunCount}
                      </td>
                      <td className="px-2 py-2 text-right align-top font-mono tabular-nums">
                        {tree.maxRequestDepth}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-5 pt-5 pb-2">
            <CardTitle className="text-base">By delegation depth</CardTitle>
            <CardDescription>
              Taken from <span className="font-mono">issues.requestDepth</span>. Depth 0 is work
              requested directly; each hop down adds one.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 px-5 pb-5 pt-2">
            {byDepth.length === 0 ? (
              <EmptyState
                icon={GitBranch}
                message="No delegation recorded"
                description="Depth appears once agents create child issues for other agents."
              />
            ) : (
              byDepth.map((depth) => (
                <div key={depth.requestDepth} className="space-y-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className={cn("font-mono text-muted-foreground")}>
                      depth {depth.requestDepth}
                    </span>
                    <span className="text-muted-foreground">
                      {depth.issueCount} issue{depth.issueCount === 1 ? "" : "s"}
                    </span>
                    <span className="font-medium tabular-nums">
                      {depth.basis === "cents"
                        ? formatCents(depth.totalCents)
                        : `${formatTokens(depth.totalTokens)} tok`}
                    </span>
                  </div>
                  <SplitMeter
                    label={`Depth ${depth.requestDepth} split`}
                    {...splitParts(depth)}
                  />
                </div>
              ))
            )}
            <MeterLegend />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
