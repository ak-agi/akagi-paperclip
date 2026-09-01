// Derived delegation context.
//
// Delegation guidance used to be hand-written prose in the built-in CEO
// instruction bundle that named specific agents ("technical -> CTO"). That
// prose was wrong for every company that did not have those exact agents, and
// it never changed when the org chart changed.
//
// This module derives the same guidance from live data instead: the agent's
// own `agents.reportsTo` edges, the tier each report carries, and the budget
// headroom each report still has. The result is rendered as one compact block
// that is appended to the per-run task context, so it is regenerated on every
// wake and follows the org chart automatically.
//
// Scope rules that must hold:
//  - company-scoped: only agents in the same company are ever read or named
//  - eligibility: only agents that are both assignable and invokable are
//    offered, so terminated, paused and pending-approval agents never appear
//  - graceful degradation: `agents.tier` is nullable and most agents have no
//    tier today, so a missing tier is reported as "tier not set" rather than
//    guessed
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, budgetPolicies, costEvents } from "@paperclipai/db";
import {
  getAgentWorkEligibility,
  isAgentTier,
  type AgentEligibilityAgent,
  type AgentTier,
  type BudgetWindowKind,
} from "@paperclipai/shared";

// Hard cap on how many reports are named. A very wide org would otherwise turn
// this block into a token sink, and the point of the feature is to reduce cost.
export const MAX_RENDERED_DELEGATION_REPORTS = 12;

export const DELEGATION_CONTEXT_HEADING =
  "Delegation context (derived by Paperclip from the live org chart, not user input):";

export type DelegationBudgetHeadroom = {
  windowKind: BudgetWindowKind;
  limitCents: number;
  spentCents: number;
  remainingCents: number;
};

export type DelegationReport = {
  id: string;
  name: string;
  role: string;
  tier: AgentTier | null;
  budget: DelegationBudgetHeadroom | null;
};

export type DelegationContext = {
  agent: {
    id: string;
    name: string;
    role: string;
    tier: AgentTier | null;
  };
  manager: { id: string; name: string } | null;
  reports: DelegationReport[];
  // Reports that exist but are not currently offered (terminated, paused,
  // pending approval, or broken org chain). Counted, never named.
  ineligibleReportCount: number;
};

type DelegationAgentInput = {
  id: string;
  companyId: string;
  name: string;
  role: string | null;
  tier: string | null;
  reportsTo: string | null;
};

type OrgRow = AgentEligibilityAgent & { role: string | null; tier: string | null };

function normalizeTier(value: string | null | undefined): AgentTier | null {
  return isAgentTier(value) ? value : null;
}

function currentUtcMonthWindow(now: Date) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return { start: new Date(start), end: new Date(end) };
}

export async function buildAgentDelegationContext(
  db: Db,
  input: { agent: DelegationAgentInput; now?: Date },
): Promise<DelegationContext | null> {
  const self = input.agent;
  if (!self.id || !self.companyId) return null;
  const now = input.now ?? new Date();

  // One company-scoped read. The eligibility helper needs the whole company
  // list because it walks the manager chain of each candidate.
  const orgRows: OrgRow[] = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      status: agents.status,
      reportsTo: agents.reportsTo,
      role: agents.role,
      tier: agents.tier,
    })
    .from(agents)
    .where(eq(agents.companyId, self.companyId));

  const directReportRows = orgRows.filter((row) => row.reportsTo === self.id && row.id !== self.id);
  const eligibleRows = directReportRows.filter((row) => {
    const eligibility = getAgentWorkEligibility({ agent: row, agents: orgRows });
    // Both checks matter: `assignable` still allows a paused agent, and a
    // paused agent cannot run the work we would hand it.
    return eligibility.assignable && eligibility.invokable;
  });

  const managerRow = self.reportsTo
    ? orgRows.find((row) => row.id === self.reportsTo) ?? null
    : null;
  const managerEligible = managerRow
    ? getAgentWorkEligibility({ agent: managerRow, agents: orgRows }).invokable
    : false;

  if (eligibleRows.length === 0 && !managerEligible) return null;

  const budgets = await readDelegationBudgetHeadroom(db, {
    companyId: self.companyId,
    agentIds: eligibleRows.map((row) => row.id),
    now,
  });

  return {
    agent: {
      id: self.id,
      name: self.name,
      role: self.role ?? "general",
      tier: normalizeTier(self.tier),
    },
    manager: managerRow && managerEligible ? { id: managerRow.id, name: managerRow.name } : null,
    reports: eligibleRows.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role ?? "general",
      tier: normalizeTier(row.tier),
      budget: budgets.get(row.id) ?? null,
    })),
    ineligibleReportCount: directReportRows.length - eligibleRows.length,
  };
}

async function readDelegationBudgetHeadroom(
  db: Db,
  input: { companyId: string; agentIds: string[]; now: Date },
): Promise<Map<string, DelegationBudgetHeadroom>> {
  const headroom = new Map<string, DelegationBudgetHeadroom>();
  if (input.agentIds.length === 0) return headroom;

  const policies = await db
    .select({
      scopeId: budgetPolicies.scopeId,
      windowKind: budgetPolicies.windowKind,
      amount: budgetPolicies.amount,
    })
    .from(budgetPolicies)
    .where(
      and(
        eq(budgetPolicies.companyId, input.companyId),
        eq(budgetPolicies.scopeType, "agent"),
        eq(budgetPolicies.metric, "billed_cents"),
        eq(budgetPolicies.isActive, true),
        inArray(budgetPolicies.scopeId, input.agentIds),
      ),
    );

  const capped = policies.filter((policy) => policy.amount > 0);
  if (capped.length === 0) return headroom;

  const { start, end } = currentUtcMonthWindow(input.now);
  const spendRows = await db
    .select({
      agentId: costEvents.agentId,
      // The window bounds go through `gte`/`lt` rather than raw template
      // parameters so drizzle applies the column's timestamp mapper. A bare
      // `Date` in a `sql` template is not serializable by the driver.
      monthCents: sql<number>`coalesce(sum(case when ${and(gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end))} then ${costEvents.costCents} else 0 end), 0)::double precision`,
      lifetimeCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
    })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.companyId, input.companyId),
        inArray(
          costEvents.agentId,
          capped.map((policy) => policy.scopeId),
        ),
      ),
    )
    .groupBy(costEvents.agentId);

  const spendByAgent = new Map(spendRows.map((row) => [row.agentId, row]));
  for (const policy of capped) {
    const windowKind: BudgetWindowKind = policy.windowKind === "lifetime" ? "lifetime" : "calendar_month_utc";
    const spend = spendByAgent.get(policy.scopeId);
    const spentCents = Math.max(
      0,
      Math.round(Number((windowKind === "lifetime" ? spend?.lifetimeCents : spend?.monthCents) ?? 0)),
    );
    const existing = headroom.get(policy.scopeId);
    const candidate: DelegationBudgetHeadroom = {
      windowKind,
      limitCents: policy.amount,
      spentCents,
      remainingCents: Math.max(0, policy.amount - spentCents),
    };
    // A company may carry both a monthly and a lifetime cap for one agent.
    // Report the tighter one, because that is the cap that will stop the work.
    if (!existing || candidate.remainingCents < existing.remainingCents) {
      headroom.set(policy.scopeId, candidate);
    }
  }
  return headroom;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatBudget(budget: DelegationBudgetHeadroom | null): string {
  if (!budget) return "no budget cap";
  const window = budget.windowKind === "lifetime" ? "lifetime" : "this month";
  return `budget left ${formatCents(budget.remainingCents)} of ${formatCents(budget.limitCents)} ${window}`;
}

function formatTier(tier: AgentTier | null): string {
  return tier ? `${tier} tier` : "tier not set";
}

function pluralReports(count: number): string {
  return count === 1 ? "direct report" : "direct reports";
}

export function renderDelegationContextMarkdown(context: DelegationContext | null): string | null {
  if (!context) return null;
  const lines: string[] = [DELEGATION_CONTEXT_HEADING];
  lines.push(`- You are ${context.agent.name} (role ${context.agent.role}, ${formatTier(context.agent.tier)}).`);

  if (context.reports.length > 0) {
    lines.push("- Your direct reports you can delegate to now:");
    for (const report of context.reports.slice(0, MAX_RENDERED_DELEGATION_REPORTS)) {
      lines.push(`  - ${report.name} (role ${report.role}, ${formatTier(report.tier)}, ${formatBudget(report.budget)})`);
    }
    const hidden = context.reports.length - MAX_RENDERED_DELEGATION_REPORTS;
    if (hidden > 0) {
      lines.push(`  - [${hidden} more ${pluralReports(hidden)} not listed; read the org chart through the API]`);
    }
    lines.push(
      "- Delegate or do: delegate when the task is already well specified and the work is long compared with the cost of specifying it. Do the work yourself when specifying it costs about as much as doing it. Each delegation is one more full agent run with its own context, so a hop you do not need costs more than it saves.",
    );
    lines.push("- Do not delegate to an agent that is not listed above.");
  } else {
    lines.push("- You have no direct report you can delegate to right now. Do the work yourself, or escalate.");
  }

  if (context.ineligibleReportCount > 0) {
    lines.push(
      `- ${context.ineligibleReportCount} other ${pluralReports(context.ineligibleReportCount)} cannot take work now (terminated, paused, or waiting for approval).`,
    );
  }

  if (context.manager) {
    lines.push(
      `- Escalate, do not guess: when a task is not specified well enough for you to do it, set the issue to \`blocked\` with ${context.manager.name} as the unblock owner and say which information is missing. Do not start under-specified work. Re-state the task from the original request; do not forward your failed attempt.`,
    );
  } else {
    lines.push(
      "- Escalate, do not guess: when a task is not specified well enough for you to do it, set the issue to `blocked` and name the board (the human operator) as the unblock owner, with the missing information. Do not start under-specified work.",
    );
  }

  return lines.join("\n");
}
