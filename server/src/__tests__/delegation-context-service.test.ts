import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildAgentDelegationContext,
  renderDelegationContextMarkdown,
} from "../services/delegation-context.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres delegation context tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("derived delegation context", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-delegation-context-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany(name: string) {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function createAgent(input: {
    companyId: string;
    name: string;
    role?: string;
    tier?: string | null;
    status?: string;
    reportsTo?: string | null;
  }) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId: input.companyId,
      name: input.name,
      role: input.role ?? "engineer",
      tier: input.tier ?? null,
      status: input.status ?? "idle",
      reportsTo: input.reportsTo ?? null,
    });
    return id;
  }

  function selfInput(input: {
    id: string;
    companyId: string;
    name: string;
    role?: string;
    tier?: string | null;
    reportsTo?: string | null;
  }) {
    return {
      id: input.id,
      companyId: input.companyId,
      name: input.name,
      role: input.role ?? "ceo",
      tier: input.tier ?? null,
      reportsTo: input.reportsTo ?? null,
    };
  }

  it("lists the agent's real direct reports with role and tier", async () => {
    const companyId = await createCompany("Acme");
    const ceoId = await createAgent({ companyId, name: "Ada", role: "ceo", tier: "principal" });
    await createAgent({ companyId, name: "Bob", role: "cto", tier: "senior", reportsTo: ceoId });
    await createAgent({ companyId, name: "Carol", role: "designer", reportsTo: ceoId });

    const context = await buildAgentDelegationContext(db, {
      agent: selfInput({ id: ceoId, companyId, name: "Ada", tier: "principal" }),
    });

    expect(context).not.toBeNull();
    expect(context!.reports.map((report) => report.name).sort()).toEqual(["Bob", "Carol"]);
    expect(context!.reports.find((report) => report.name === "Bob")).toMatchObject({
      role: "cto",
      tier: "senior",
    });
    // `agents.tier` is nullable and most agents carry no tier today. A missing
    // tier must stay missing, never be guessed from the role or the org depth.
    expect(context!.reports.find((report) => report.name === "Carol")!.tier).toBeNull();

    const rendered = renderDelegationContextMarkdown(context)!;
    expect(rendered).toContain("Bob (role cto, senior tier");
    expect(rendered).toContain("Carol (role designer, tier not set");
    expect(rendered).not.toContain("Carol (role designer, junior");
  });

  it("never names an agent from another company", async () => {
    const companyId = await createCompany("Acme");
    const otherCompanyId = await createCompany("Rival");
    const ceoId = await createAgent({ companyId, name: "Ada", role: "ceo" });
    await createAgent({ companyId, name: "Bob", role: "cto", reportsTo: ceoId });
    // Same reportsTo value, different company. A query that forgets the company
    // filter would pick this row up.
    await createAgent({
      companyId: otherCompanyId,
      name: "RivalSpy",
      role: "cto",
      reportsTo: ceoId,
    });

    const context = await buildAgentDelegationContext(db, {
      agent: selfInput({ id: ceoId, companyId, name: "Ada" }),
    });

    expect(context!.reports.map((report) => report.name)).toEqual(["Bob"]);
    expect(context!.ineligibleReportCount).toBe(0);
    expect(renderDelegationContextMarkdown(context)!).not.toContain("RivalSpy");
  });

  it("omits reports that cannot take work now and only counts them", async () => {
    const companyId = await createCompany("Acme");
    const ceoId = await createAgent({ companyId, name: "Ada", role: "ceo" });
    await createAgent({ companyId, name: "Active", role: "cto", reportsTo: ceoId });
    await createAgent({ companyId, name: "Terminated", status: "terminated", reportsTo: ceoId });
    await createAgent({ companyId, name: "Paused", status: "paused", reportsTo: ceoId });
    await createAgent({ companyId, name: "Pending", status: "pending_approval", reportsTo: ceoId });

    const context = await buildAgentDelegationContext(db, {
      agent: selfInput({ id: ceoId, companyId, name: "Ada" }),
    });

    expect(context!.reports.map((report) => report.name)).toEqual(["Active"]);
    expect(context!.ineligibleReportCount).toBe(3);

    const rendered = renderDelegationContextMarkdown(context)!;
    for (const hidden of ["Terminated", "Paused", "Pending"]) {
      expect(rendered).not.toContain(hidden);
    }
    expect(rendered).toContain("3 other direct reports cannot take work now");
  });

  it("reports budget headroom from the live cost ledger", async () => {
    const companyId = await createCompany("Acme");
    const ceoId = await createAgent({ companyId, name: "Ada", role: "ceo" });
    const bobId = await createAgent({ companyId, name: "Bob", role: "cto", reportsTo: ceoId });
    const carolId = await createAgent({ companyId, name: "Carol", role: "designer", reportsTo: ceoId });

    await db.insert(budgetPolicies).values({
      companyId,
      scopeType: "agent",
      scopeId: bobId,
      metric: "billed_cents",
      windowKind: "calendar_month_utc",
      amount: 10_000,
      isActive: true,
    });
    const now = new Date(Date.UTC(2026, 8, 15, 12, 0, 0));
    await db.insert(costEvents).values([
      {
        companyId,
        agentId: bobId,
        provider: "anthropic",
        model: "test-model",
        costCents: 2_500,
        occurredAt: new Date(Date.UTC(2026, 8, 4, 0, 0, 0)),
      },
      // Previous month: must not count against a calendar-month cap.
      {
        companyId,
        agentId: bobId,
        provider: "anthropic",
        model: "test-model",
        costCents: 9_000,
        occurredAt: new Date(Date.UTC(2026, 7, 4, 0, 0, 0)),
      },
    ]);

    const context = await buildAgentDelegationContext(db, {
      agent: selfInput({ id: ceoId, companyId, name: "Ada" }),
      now,
    });

    const bob = context!.reports.find((report) => report.id === bobId)!;
    expect(bob.budget).toEqual({
      windowKind: "calendar_month_utc",
      limitCents: 10_000,
      spentCents: 2_500,
      remainingCents: 7_500,
    });
    // No policy at all means no cap to report, not a cap of zero.
    expect(context!.reports.find((report) => report.id === carolId)!.budget).toBeNull();

    const rendered = renderDelegationContextMarkdown(context)!;
    expect(rendered).toContain("budget left $75.00 of $100.00 this month");
    expect(rendered).toContain("Carol (role designer, tier not set, no budget cap)");
  });

  it("names the manager in the escalation rule and falls back to the board", async () => {
    const companyId = await createCompany("Acme");
    const ceoId = await createAgent({ companyId, name: "Ada", role: "ceo" });
    const ctoId = await createAgent({ companyId, name: "Bob", role: "cto", reportsTo: ceoId });
    await createAgent({ companyId, name: "Junior", role: "engineer", tier: "junior", reportsTo: ctoId });

    const engineerContext = await buildAgentDelegationContext(db, {
      agent: selfInput({ id: ctoId, companyId, name: "Bob", role: "cto", reportsTo: ceoId }),
    });
    expect(engineerContext!.manager).toMatchObject({ id: ceoId, name: "Ada" });
    expect(renderDelegationContextMarkdown(engineerContext)!).toContain(
      "with Ada as the unblock owner",
    );

    const ceoContext = await buildAgentDelegationContext(db, {
      agent: selfInput({ id: ceoId, companyId, name: "Ada" }),
    });
    expect(ceoContext!.manager).toBeNull();
    expect(renderDelegationContextMarkdown(ceoContext)!).toContain(
      "name the board (the human operator) as the unblock owner",
    );
  });

  it("emits the escalation rule for a leaf agent that has no reports", async () => {
    const companyId = await createCompany("Acme");
    const ceoId = await createAgent({ companyId, name: "Ada", role: "ceo" });
    const leafId = await createAgent({ companyId, name: "Junior", role: "engineer", tier: "junior", reportsTo: ceoId });

    const context = await buildAgentDelegationContext(db, {
      agent: selfInput({ id: leafId, companyId, name: "Junior", role: "engineer", tier: "junior", reportsTo: ceoId }),
    });

    expect(context!.reports).toEqual([]);
    const rendered = renderDelegationContextMarkdown(context)!;
    expect(rendered).toContain("You are Junior (role engineer, junior tier).");
    expect(rendered).toContain("You have no direct report you can delegate to right now.");
    expect(rendered).not.toContain("Delegate or do:");
    expect(rendered).toContain("with Ada as the unblock owner");
  });

  it("returns nothing for a solo agent with no manager and no reports", async () => {
    const companyId = await createCompany("Acme");
    const soloId = await createAgent({ companyId, name: "Solo", role: "engineer" });

    const context = await buildAgentDelegationContext(db, {
      agent: selfInput({ id: soloId, companyId, name: "Solo", role: "engineer" }),
    });

    expect(context).toBeNull();
    expect(renderDelegationContextMarkdown(context)).toBeNull();
  });

  it("does not offer a manager who cannot run", async () => {
    const companyId = await createCompany("Acme");
    const pausedCeoId = await createAgent({ companyId, name: "Ada", role: "ceo", status: "paused" });
    const ctoId = await createAgent({ companyId, name: "Bob", role: "cto", reportsTo: pausedCeoId });
    await createAgent({ companyId, name: "Dev", role: "engineer", reportsTo: ctoId });

    const context = await buildAgentDelegationContext(db, {
      agent: selfInput({ id: ctoId, companyId, name: "Bob", role: "cto", reportsTo: pausedCeoId }),
    });

    expect(context!.manager).toBeNull();
    expect(renderDelegationContextMarkdown(context)!).toContain("name the board (the human operator)");
  });

  it("carries the delegate-or-do rule whenever a report is available", async () => {
    const companyId = await createCompany("Acme");
    const ceoId = await createAgent({ companyId, name: "Ada", role: "ceo" });
    await createAgent({ companyId, name: "Bob", role: "cto", reportsTo: ceoId });

    const rendered = renderDelegationContextMarkdown(
      await buildAgentDelegationContext(db, {
        agent: selfInput({ id: ceoId, companyId, name: "Ada" }),
      }),
    )!;

    expect(rendered).toContain(
      "delegate when the task is already well specified and the work is long compared with the cost of specifying it",
    );
    expect(rendered).toContain("Do the work yourself when specifying it costs about as much as doing it");
    expect(rendered).toContain("Do not delegate to an agent that is not listed above.");
  });
});
