import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent profile consent gate route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Db = ReturnType<typeof createDb>;

/**
 * Route-layer regression coverage for the agent profile change consent gate.
 *
 * The gate used to run only when EVERY key in the patch was a consent field,
 * so an agent-authenticated caller could re-tier (or rename, or re-title)
 * itself simply by appending one unrelated key to the patch: an
 * `agent_config:update` decision without `requiresChangeGrant` resolves to an
 * unconditional self-allow. These tests exercise the real authorization
 * service and the real consent gate against embedded Postgres, so a
 * route-level regression cannot hide behind a mocked `access.decide`.
 */
describeEmbeddedPostgres("agent profile change consent gate (routes)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-profile-consent-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 }).catch(() => {});
    await tempDb?.cleanup();
  });

  async function seedFixture(options: { permissionKey?: string | null } = {}) {
    const permissionKey = options.permissionKey === undefined
      ? "agents:suggest-changes"
      : options.permissionKey;
    const companyId = randomUUID();
    const agentId = randomUUID();
    const priorRunId = randomUUID();
    const actorRunId = randomUUID();
    const proposalIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `Consent Gate ${companyId}`,
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Builder",
      role: "engineer",
      title: "Builder",
      tier: null,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
      updatedAt: new Date(),
    });
    if (permissionKey) {
      await db.insert(principalPermissionGrants).values({
        companyId,
        principalType: "agent",
        principalId: agentId,
        permissionKey,
        grantedByUserId: null,
      });
    }
    await db.insert(heartbeatRuns).values([
      { id: priorRunId, companyId, agentId, status: "succeeded" },
      { id: actorRunId, companyId, agentId, status: "running" },
    ]);
    await db.insert(issues).values({
      id: proposalIssueId,
      companyId,
      title: "Review agent profile proposal",
      status: "in_review",
      priority: "medium",
      identifier: "CG-1",
      issueNumber: 1,
      createdByAgentId: agentId,
    });

    return { companyId, agentId, priorRunId, actorRunId, proposalIssueId };
  }

  async function recordAcceptedProfileConsent(fixture: {
    companyId: string;
    agentId: string;
    priorRunId: string;
    proposalIssueId: string;
  }) {
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId: fixture.companyId,
      issueId: fixture.proposalIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId: fixture.priorRunId,
      createdByAgentId: fixture.agentId,
      payload: {
        version: 1,
        prompt: "Apply this agent profile change?",
        detailsMarkdown: "```diff\n-tier: null\n+tier: principal\n```",
        target: { type: "custom", key: `agent:${fixture.agentId}:profile`, revisionId: "profile-v1" },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "board-user",
      resolvedAt: new Date(),
    });
  }

  function agentApp(fixture: { companyId: string; agentId: string; actorRunId: string }) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = {
        type: "agent",
        agentId: fixture.agentId,
        companyId: fixture.companyId,
        runId: fixture.actorRunId,
        source: "agent_jwt",
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function readAgentRow(agentId: string) {
    const [row] = await db
      .select({ name: agents.name, tier: agents.tier })
      .from(agents)
      .where(eq(agents.id, agentId));
    return row ?? null;
  }

  it("rejects an agent self re-tier smuggled alongside a non-consent field", async () => {
    const fixture = await seedFixture();

    const res = await request(agentApp(fixture))
      .patch(`/api/agents/${fixture.agentId}`)
      .send({ tier: "principal", icon: "bot" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect((await readAgentRow(fixture.agentId))?.tier ?? null).toBeNull();
  });

  it("rejects a profile-only agent self re-tier without consent", async () => {
    const fixture = await seedFixture();

    const res = await request(agentApp(fixture))
      .patch(`/api/agents/${fixture.agentId}`)
      .send({ tier: "principal" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect((await readAgentRow(fixture.agentId))?.tier ?? null).toBeNull();
  });

  it("rejects a mixed patch that also renames the agent without consent", async () => {
    const fixture = await seedFixture();

    const res = await request(agentApp(fixture))
      .patch(`/api/agents/${fixture.agentId}`)
      .send({ name: "Principal Builder", icon: "bot" });

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect((await readAgentRow(fixture.agentId))?.name).toBe("Builder");
  });

  it("applies a mixed patch once a previous-run consent record exists", async () => {
    const fixture = await seedFixture();
    await recordAcceptedProfileConsent(fixture);

    const res = await request(agentApp(fixture))
      .patch(`/api/agents/${fixture.agentId}`)
      .send({ tier: "principal", icon: "bot" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.tier).toBe("principal");
    expect(res.body.icon).toBe("bot");
    expect((await readAgentRow(fixture.agentId))?.tier).toBe("principal");
  });

  it("still allows an agent self-update that touches no consent field", async () => {
    const fixture = await seedFixture({ permissionKey: null });

    const res = await request(agentApp(fixture))
      .patch(`/api/agents/${fixture.agentId}`)
      .send({ icon: "bot" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.icon).toBe("bot");
    expect((await readAgentRow(fixture.agentId))?.tier ?? null).toBeNull();
  });
});
