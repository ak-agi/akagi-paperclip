import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  getEmbeddedPostgresTestSupport,
  heartbeatRuns,
  issueComments,
  issues,
  issueWorkProducts,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { clampTreeLimit, orchestrationCostService } from "../services/orchestration-costs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("clampTreeLimit", () => {
  it("falls back to the default when the limit is absent or nonsense", () => {
    expect(clampTreeLimit(undefined)).toBe(25);
    expect(clampTreeLimit(Number.NaN)).toBe(25);
    expect(clampTreeLimit(0)).toBe(25);
    expect(clampTreeLimit(-4)).toBe(25);
  });

  it("caps the limit so a large company cannot request an unbounded page", () => {
    expect(clampTreeLimit(10)).toBe(10);
    expect(clampTreeLimit(10.9)).toBe(10);
    expect(clampTreeLimit(5_000)).toBe(200);
  });
});

describeEmbeddedPostgres("orchestration cost read model", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof orchestrationCostService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-orchestration-costs-");
    db = createDb(tempDb.connectionString);
    service = orchestrationCostService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issueWorkProducts);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let identifierSeq = 0;

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${prefix} Agent`,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  /**
   * Issues default to `done` so the common case exercises the verdict path.
   * The in-flight gate is exercised by passing a live status explicitly.
   */
  async function seedIssue(input: {
    companyId: string;
    parentId?: string | null;
    requestDepth: number;
    title: string;
    status?: string;
    hidden?: boolean;
  }) {
    const id = randomUUID();
    identifierSeq += 1;
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      parentId: input.parentId ?? null,
      title: input.title,
      status: input.status ?? "done",
      priority: "medium",
      requestDepth: input.requestDepth,
      issueNumber: identifierSeq,
      identifier: `ORC-${identifierSeq}`,
      hiddenAt: input.hidden ? new Date("2026-07-01T00:00:00.000Z") : null,
    });
    return id;
  }

  async function seedRun(companyId: string, agentId: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      status: "succeeded",
      startedAt: new Date("2026-08-01T00:00:00.000Z"),
      finishedAt: new Date("2026-08-01T00:05:00.000Z"),
    });
    return id;
  }

  async function markExecutionRun(companyId: string, issueId: string, runId: string) {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: "Ship the change",
      status: "open",
      createdByRunId: runId,
    });
  }

  async function markOrchestrationRun(companyId: string, issueId: string, runId: string) {
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: "agent",
      action: "issue.child_created",
      entityType: "issue",
      entityId: issueId,
      runId,
    });
  }

  async function seedCostEvent(input: {
    companyId: string;
    agentId: string;
    issueId: string | null;
    runId: string | null;
    costCents: number;
    inputTokens?: number;
    outputTokens?: number;
    costStatus?: "reported" | "unpriced";
    billingType?: string;
  }) {
    await db.insert(costEvents).values({
      companyId: input.companyId,
      agentId: input.agentId,
      issueId: input.issueId,
      heartbeatRunId: input.runId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: input.billingType ?? "metered_api",
      costStatus: input.costStatus ?? "reported",
      model: "claude-test",
      inputTokens: input.inputTokens ?? 0,
      cachedInputTokens: 0,
      outputTokens: input.outputTokens ?? 0,
      costCents: input.costCents,
      occurredAt: new Date("2026-08-01T00:02:00.000Z"),
    });
  }

  it("splits a delegation tree into orchestration, execution, and unclassified spend", async () => {
    const { companyId, agentId } = await seedCompany("ORCA");
    const rootId = await seedIssue({ companyId, requestDepth: 0, title: "Root" });
    const childId = await seedIssue({ companyId, parentId: rootId, requestDepth: 1, title: "Child" });
    const grandchildId = await seedIssue({
      companyId,
      parentId: childId,
      requestDepth: 2,
      title: "Grandchild",
    });

    const orchestrationRun = await seedRun(companyId, agentId);
    const executionRun = await seedRun(companyId, agentId);
    const idleRun = await seedRun(companyId, agentId);

    await markOrchestrationRun(companyId, rootId, orchestrationRun);
    await markExecutionRun(companyId, childId, executionRun);

    await seedCostEvent({
      companyId,
      agentId,
      issueId: rootId,
      runId: orchestrationRun,
      costCents: 700,
      inputTokens: 70,
    });
    await seedCostEvent({
      companyId,
      agentId,
      issueId: childId,
      runId: executionRun,
      costCents: 300,
      inputTokens: 30,
    });
    await seedCostEvent({
      companyId,
      agentId,
      issueId: grandchildId,
      runId: idleRun,
      costCents: 100,
      inputTokens: 10,
    });

    const report = await service.report(companyId);

    expect(report.summary.orchestrationCents).toBe(700);
    expect(report.summary.executionCents).toBe(300);
    expect(report.summary.unclassifiedCents).toBe(100);
    expect(report.summary.totalCents).toBe(1100);
    // share of classified spend (700 of 1000), not of the 1100 total: the ratio
    // and the inversion verdict must share a denominator
    expect(report.summary.orchestrationCostRatio).toBeCloseTo(0.7, 4);
    expect(report.summary.basis).toBe("cents");
    expect(report.summary.orchestrationRunCount).toBe(1);
    expect(report.summary.executionRunCount).toBe(1);
    expect(report.summary.unclassifiedRunCount).toBe(1);
    expect(report.summary.invertedTreeCount).toBe(1);
    expect(report.summary.judgedTreeCount).toBe(1);
    expect(report.summary.treeCount).toBe(1);
    expect(report.summary.exclusions.totalEventCount).toBe(3);
    expect(report.summary.exclusions.countedEventCount).toBe(3);
    expect(report.summary.exclusions.totalCostCents).toBe(1100);
    expect(report.summary.exclusions.heldOutCostCents).toBe(0);

    expect(report.trees).toHaveLength(1);
    const [tree] = report.trees;
    expect(tree.rootIssueId).toBe(rootId);
    expect(tree.rootIssueTitle).toBe("Root");
    expect(tree.issueCount).toBe(3);
    expect(tree.maxRequestDepth).toBe(2);
    expect(tree.orchestrationCents).toBe(700);
    expect(tree.executionCents).toBe(300);
    // orchestration outweighs execution — the plan §9 invariant breach
    expect(tree.overheadVerdict).toBe("inverted");
    expect(tree.inFlight).toBe(false);

    expect(report.summary.issueCount).toBe(3);
    expect(report.byDepth.map((row) => row.requestDepth)).toEqual([0, 1, 2]);
    expect(report.byDepth.map((row) => row.issueCount)).toEqual([1, 1, 1]);
    expect(report.byDepth[0].orchestrationCents).toBe(700);
    expect(report.byDepth[1].executionCents).toBe(300);
    expect(report.byDepth[2].unclassifiedCents).toBe(100);
  });

  it("counts a document revision as execution work", async () => {
    const { companyId, agentId } = await seedCompany("ORCD");
    const rootId = await seedIssue({ companyId, requestDepth: 0, title: "Doc root" });
    const runId = await seedRun(companyId, agentId);

    const documentId = randomUUID();
    await db.insert(documents).values({
      id: documentId,
      companyId,
      title: "Spec",
      latestBody: "body",
    });
    await db.insert(documentRevisions).values({
      companyId,
      documentId,
      revisionNumber: 1,
      body: "body",
      createdByRunId: runId,
    });

    await seedCostEvent({ companyId, agentId, issueId: rootId, runId, costCents: 250 });

    const report = await service.report(companyId);

    expect(report.summary.executionCents).toBe(250);
    expect(report.summary.orchestrationCents).toBe(0);
    expect(report.trees[0].overheadVerdict).toBe("balanced");
  });

  it("counts a comment-only run as orchestration", async () => {
    const { companyId, agentId } = await seedCompany("ORCC");
    const rootId = await seedIssue({ companyId, requestDepth: 0, title: "Comment root" });
    const runId = await seedRun(companyId, agentId);

    await db.insert(issueComments).values({
      companyId,
      issueId: rootId,
      authorType: "agent",
      createdByRunId: runId,
      body: "Handing this to the platform team.",
    });
    await seedCostEvent({ companyId, agentId, issueId: rootId, runId, costCents: 90 });

    const report = await service.report(companyId);

    expect(report.summary.orchestrationCents).toBe(90);
    expect(report.summary.orchestrationRunCount).toBe(1);
    expect(report.summary.executionRunCount).toBe(0);
  });

  it("excludes unpriced rows from cost sums but keeps their tokens and a footnote count", async () => {
    const { companyId, agentId } = await seedCompany("ORCU");
    const rootId = await seedIssue({ companyId, requestDepth: 0, title: "Unpriced root" });
    const childId = await seedIssue({ companyId, parentId: rootId, requestDepth: 1, title: "Child" });

    const orchestrationRun = await seedRun(companyId, agentId);
    const executionRun = await seedRun(companyId, agentId);
    await markOrchestrationRun(companyId, rootId, orchestrationRun);
    await markExecutionRun(companyId, childId, executionRun);

    // a huge unpriced orchestration row would flip the ratio if it were counted
    await seedCostEvent({
      companyId,
      agentId,
      issueId: rootId,
      runId: orchestrationRun,
      costCents: 999_999,
      inputTokens: 900,
      costStatus: "unpriced",
    });
    await seedCostEvent({
      companyId,
      agentId,
      issueId: rootId,
      runId: orchestrationRun,
      costCents: 100,
      inputTokens: 100,
    });
    await seedCostEvent({
      companyId,
      agentId,
      issueId: childId,
      runId: executionRun,
      costCents: 300,
      inputTokens: 300,
    });

    const report = await service.report(companyId);

    expect(report.summary.orchestrationCents).toBe(100);
    expect(report.summary.executionCents).toBe(300);
    expect(report.summary.totalCents).toBe(400);
    expect(report.summary.orchestrationCostRatio).toBeCloseTo(0.25, 4);
    expect(report.summary.unpricedEventCount).toBe(1);
    // tokens still include the unpriced row, because quota is still consumed
    expect(report.summary.orchestrationTokens).toBe(1000);
    expect(report.summary.executionTokens).toBe(300);
    // an unpriced row alongside priced ones means the cent sums no longer cover
    // all of the work, so no verdict is issued on them
    expect(report.summary.basis).toBe("indeterminate");
    expect(report.trees[0].overheadVerdict).toBe("indeterminate");
  });

  it("holds subscription-billed rows out of cost sums and reads them on tokens instead", async () => {
    const { companyId, agentId } = await seedCompany("ORCS");
    const rootId = await seedIssue({ companyId, requestDepth: 0, title: "Subscription root" });
    const childId = await seedIssue({ companyId, parentId: rootId, requestDepth: 1, title: "Child" });

    const orchestrationRun = await seedRun(companyId, agentId);
    const executionRun = await seedRun(companyId, agentId);
    await markOrchestrationRun(companyId, rootId, orchestrationRun);
    await markExecutionRun(companyId, childId, executionRun);

    await seedCostEvent({
      companyId,
      agentId,
      issueId: rootId,
      runId: orchestrationRun,
      costCents: 5_000,
      inputTokens: 8_000_000,
      billingType: "subscription_included",
    });
    await seedCostEvent({
      companyId,
      agentId,
      issueId: childId,
      runId: executionRun,
      costCents: 5_000,
      inputTokens: 2_000_000,
      billingType: "subscription_included",
    });

    const report = await service.report(companyId);

    expect(report.summary.totalCents).toBe(0);
    expect(report.summary.orchestrationCostRatio).toBeNull();
    expect(report.summary.subscriptionEventCount).toBe(2);
    expect(report.summary.orchestrationTokenRatio).toBeCloseTo(0.8, 4);
    expect(report.summary.basis).toBe("tokens");
    // with no priced spend anywhere, tokens are the only unit and every row
    // contributes to them, so the comparison is still honest
    expect(report.trees[0].overheadVerdict).toBe("inverted");
  });

  // Regression for the headline defect: a metered manager over a
  // subscription-billed executor. The cent sums value every subscription row at
  // zero, so the old rule saw 300c of orchestration against 0c of execution and
  // reported orchestrationCostRatio 1 with the destructive "orchestration-heavy"
  // badge, on a tree that is ~98% execution by tokens. Neither unit covers both
  // sides, so the tree must not be judged at all.
  it("issues no verdict when metered and subscription billing are mixed in one tree", async () => {
    const { companyId, agentId } = await seedCompany("ORCM");
    const rootId = await seedIssue({ companyId, requestDepth: 0, title: "Mixed root" });
    const childId = await seedIssue({
      companyId,
      parentId: rootId,
      requestDepth: 1,
      title: "Delegated build",
    });

    const managerRun = await seedRun(companyId, agentId);
    const executorRun = await seedRun(companyId, agentId);
    await markOrchestrationRun(companyId, rootId, managerRun);
    await markExecutionRun(companyId, childId, executorRun);

    // metered manager: real dollars, modest tokens
    await seedCostEvent({
      companyId,
      agentId,
      issueId: rootId,
      runId: managerRun,
      costCents: 300,
      inputTokens: 100_000,
    });
    // subscription executor: no marginal dollars, most of the actual work
    await seedCostEvent({
      companyId,
      agentId,
      issueId: childId,
      runId: executorRun,
      costCents: 0,
      inputTokens: 5_000_000,
      billingType: "subscription_included",
    });

    const report = await service.report(companyId);

    expect(report.summary.orchestrationCents).toBe(300);
    expect(report.summary.executionCents).toBe(0);
    expect(report.summary.subscriptionEventCount).toBe(1);
    // tokens tell the opposite story to cents; that disagreement is the point
    expect(report.summary.orchestrationTokenRatio).toBeCloseTo(0.0196, 3);

    expect(report.summary.basis).toBe("indeterminate");
    expect(report.trees).toHaveLength(1);
    expect(report.trees[0].overheadVerdict).toBe("indeterminate");
    expect(report.summary.invertedTreeCount).toBe(0);
    expect(report.summary.judgedTreeCount).toBe(0);
    expect(report.summary.treeCount).toBe(1);
    // the subscription spend is counted, not dropped — it is just held out of cents
    expect(report.summary.exclusions.countedEventCount).toBe(2);
    expect(report.summary.exclusions.noIssueEventCount).toBe(0);
  });

  it("keeps the ratio and the inversion verdict on one denominator", async () => {
    const { companyId, agentId } = await seedCompany("ORCR");
    const rootId = await seedIssue({ companyId, requestDepth: 0, title: "Ratio root" });
    const childId = await seedIssue({ companyId, parentId: rootId, requestDepth: 1, title: "Child" });
    const otherId = await seedIssue({ companyId, parentId: rootId, requestDepth: 1, title: "Other" });

    const orchestrationRun = await seedRun(companyId, agentId);
    const executionRun = await seedRun(companyId, agentId);
    const idleRun = await seedRun(companyId, agentId);
    await markOrchestrationRun(companyId, rootId, orchestrationRun);
    await markExecutionRun(companyId, childId, executionRun);

    await seedCostEvent({ companyId, agentId, issueId: rootId, runId: orchestrationRun, costCents: 300 });
    await seedCostEvent({ companyId, agentId, issueId: childId, runId: executionRun, costCents: 250 });
    await seedCostEvent({ companyId, agentId, issueId: otherId, runId: idleRun, costCents: 450 });

    const report = await service.report(companyId);
    const [tree] = report.trees;

    // 300 of 550 classified, not 300 of 1000 total: a ratio under 50% beside an
    // "orchestration-heavy" badge was the contradiction being fixed
    expect(tree.orchestrationCostRatio).toBeCloseTo(0.5455, 4);
    expect(tree.unclassifiedCents).toBe(450);
    expect(tree.overheadVerdict).toBe("inverted");
    expect((tree.orchestrationCostRatio ?? 0) > 0.5).toBe(true);
  });

  it("does not judge a tree that has barely spent", async () => {
    const { companyId, agentId } = await seedCompany("ORCF");
    const rootId = await seedIssue({ companyId, requestDepth: 0, title: "Fresh root" });
    const runId = await seedRun(companyId, agentId);
    await markOrchestrationRun(companyId, rootId, runId);
    await seedCostEvent({ companyId, agentId, issueId: rootId, runId, costCents: 1 });

    const report = await service.report(companyId);

    expect(report.trees[0].overheadVerdict).toBe("below_floor");
    expect(report.summary.invertedTreeCount).toBe(0);
    expect(report.summary.judgedTreeCount).toBe(0);
    expect(report.thresholds.minClassifiedCents).toBe(100);
  });

  it("defers the verdict while the tree still has open work", async () => {
    const { companyId, agentId } = await seedCompany("ORCI");
    const rootId = await seedIssue({
      companyId,
      requestDepth: 0,
      title: "Live root",
      status: "in_progress",
    });
    const runId = await seedRun(companyId, agentId);
    await markOrchestrationRun(companyId, rootId, runId);
    await seedCostEvent({ companyId, agentId, issueId: rootId, runId, costCents: 900 });

    const report = await service.report(companyId);

    expect(report.trees[0].inFlight).toBe(true);
    expect(report.trees[0].overheadVerdict).toBe("in_flight");
    expect(report.summary.invertedTreeCount).toBe(0);
  });

  it("accounts for every cost event that never reaches a tree", async () => {
    const { companyId, agentId } = await seedCompany("ORCX");
    const visibleRoot = await seedIssue({ companyId, requestDepth: 0, title: "Visible root" });
    const hiddenRoot = await seedIssue({
      companyId,
      requestDepth: 0,
      title: "Hidden status card",
      hidden: true,
    });
    // the subtree under a hidden ancestor is severed even though the child itself
    // is perfectly visible — status cards and summary slots create exactly this
    const severedChild = await seedIssue({
      companyId,
      parentId: hiddenRoot,
      requestDepth: 1,
      title: "Severed child",
    });

    const visibleRun = await seedRun(companyId, agentId);
    const severedRun = await seedRun(companyId, agentId);
    await markExecutionRun(companyId, visibleRoot, visibleRun);
    await markExecutionRun(companyId, severedChild, severedRun);

    await seedCostEvent({ companyId, agentId, issueId: visibleRoot, runId: visibleRun, costCents: 400 });
    await seedCostEvent({ companyId, agentId, issueId: severedChild, runId: severedRun, costCents: 700 });
    // a valid issue but no heartbeat run: unclassifiable, and previously invisible
    await seedCostEvent({ companyId, agentId, issueId: visibleRoot, runId: null, costCents: 30 });
    await seedCostEvent({ companyId, agentId, issueId: null, runId: visibleRun, costCents: 20 });

    const report = await service.report(companyId);
    const { exclusions } = report.summary;

    expect(report.summary.totalCents).toBe(400);
    expect(exclusions.hiddenTreeEventCount).toBe(1);
    expect(exclusions.hiddenTreeCostCents).toBe(700);
    expect(exclusions.noRunEventCount).toBe(1);
    expect(exclusions.noRunCostCents).toBe(30);
    expect(exclusions.noIssueEventCount).toBe(1);
    expect(exclusions.noIssueCostCents).toBe(20);
    expect(exclusions.countedEventCount).toBe(1);
    expect(exclusions.countedCostCents).toBe(400);

    // the drop reasons and the counted rows account for the entire range, so the
    // gap against the Overview total is always explainable
    expect(exclusions.totalEventCount).toBe(4);
    expect(exclusions.totalCostCents).toBe(1150);
    expect(
      exclusions.countedCostCents +
        exclusions.hiddenTreeCostCents +
        exclusions.noRunCostCents +
        exclusions.noIssueCostCents +
        exclusions.unresolvedIssueCostCents,
    ).toBe(exclusions.totalCostCents);
  });

  it("never reads across a company boundary", async () => {
    const first = await seedCompany("ORC1");
    const second = await seedCompany("ORC2");

    const firstRoot = await seedIssue({
      companyId: first.companyId,
      requestDepth: 0,
      title: "First root",
    });
    const secondRoot = await seedIssue({
      companyId: second.companyId,
      requestDepth: 0,
      title: "Second root",
    });

    const firstRun = await seedRun(first.companyId, first.agentId);
    const secondRun = await seedRun(second.companyId, second.agentId);
    await markOrchestrationRun(first.companyId, firstRoot, firstRun);
    await markExecutionRun(second.companyId, secondRoot, secondRun);

    await seedCostEvent({
      companyId: first.companyId,
      agentId: first.agentId,
      issueId: firstRoot,
      runId: firstRun,
      costCents: 400,
      inputTokens: 40,
    });
    await seedCostEvent({
      companyId: second.companyId,
      agentId: second.agentId,
      issueId: secondRoot,
      runId: secondRun,
      costCents: 900,
      inputTokens: 90,
    });

    const firstReport = await service.report(first.companyId);
    const secondReport = await service.report(second.companyId);

    expect(firstReport.summary.companyId).toBe(first.companyId);
    expect(firstReport.summary.totalCents).toBe(400);
    expect(firstReport.trees.map((tree) => tree.rootIssueId)).toEqual([firstRoot]);
    expect(firstReport.summary.executionCents).toBe(0);

    expect(secondReport.summary.totalCents).toBe(900);
    expect(secondReport.trees.map((tree) => tree.rootIssueId)).toEqual([secondRoot]);
    expect(secondReport.summary.orchestrationCents).toBe(0);
  });

  it("reports cost events with no issue attribution separately and honors the range filter", async () => {
    const { companyId, agentId } = await seedCompany("ORCN");
    const rootId = await seedIssue({ companyId, requestDepth: 0, title: "Ranged root" });
    const runId = await seedRun(companyId, agentId);
    await markExecutionRun(companyId, rootId, runId);

    await seedCostEvent({ companyId, agentId, issueId: rootId, runId, costCents: 120 });
    await seedCostEvent({ companyId, agentId, issueId: null, runId, costCents: 55 });

    const inRange = await service.report(companyId, {
      from: new Date("2026-07-01T00:00:00.000Z"),
      to: new Date("2026-08-31T23:59:59.999Z"),
    });
    expect(inRange.summary.executionCents).toBe(120);
    expect(inRange.summary.exclusions.noIssueEventCount).toBe(1);
    expect(inRange.summary.exclusions.noIssueCostCents).toBe(55);
    expect(inRange.summary.exclusions.totalEventCount).toBe(2);

    const outOfRange = await service.report(companyId, {
      from: new Date("2026-09-01T00:00:00.000Z"),
      to: new Date("2026-09-30T23:59:59.999Z"),
    });
    expect(outOfRange.summary.totalCents).toBe(0);
    expect(outOfRange.trees).toEqual([]);
    expect(outOfRange.summary.exclusions.totalEventCount).toBe(0);
  });

  it("caps the returned trees and returns the heaviest first", async () => {
    const { companyId, agentId } = await seedCompany("ORCL");
    for (const cents of [10, 50, 30]) {
      const rootId = await seedIssue({ companyId, requestDepth: 0, title: `Root ${cents}` });
      const runId = await seedRun(companyId, agentId);
      await markExecutionRun(companyId, rootId, runId);
      await seedCostEvent({ companyId, agentId, issueId: rootId, runId, costCents: cents });
    }

    const report = await service.report(companyId, undefined, { limit: 2 });

    expect(report.trees).toHaveLength(2);
    expect(report.trees.map((tree) => tree.totalCents)).toEqual([50, 30]);
    expect(report.summary.totalCents).toBe(90);
  });
});
