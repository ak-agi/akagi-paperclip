import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentConfigRevisions,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent tier tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent service tier", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-tier-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentConfigRevisions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("defaults a new agent to no declared tier", async () => {
    const cid = await createCompany();
    const created = await agentService(db).create(cid, {
      name: "Untiered",
      role: "engineer",
      adapterType: "process",
    });

    expect(created.tier).toBeNull();
  });

  it("round-trips a tier through create, read, update and clear", async () => {
    const cid = await createCompany();
    const svc = agentService(db);

    const created = await svc.create(cid, {
      name: "Junior Coder",
      role: "engineer",
      tier: "junior",
      adapterType: "process",
    });
    expect(created.tier).toBe("junior");

    const read = await svc.getById(created.id);
    expect(read?.tier).toBe("junior");

    const promoted = await svc.update(created.id, { tier: "senior" });
    expect(promoted?.tier).toBe("senior");

    const cleared = await svc.update(created.id, { tier: null });
    expect(cleared?.tier).toBeNull();
  });

  it("tracks the tier in agent config revisions and restores it on rollback", async () => {
    const cid = await createCompany();
    const svc = agentService(db);

    const created = await svc.create(cid, {
      name: "Tracked",
      role: "engineer",
      tier: "mid",
      adapterType: "process",
    });

    const updated = await svc.update(
      created.id,
      { tier: "principal" },
      { recordRevision: { source: "patch" } },
    );
    expect(updated?.tier).toBe("principal");

    const revisions = await svc.listConfigRevisions(created.id);
    expect(revisions).toHaveLength(1);
    const revision = revisions[0]!;
    expect(revision.changedKeys).toContain("tier");
    expect((revision.beforeConfig as Record<string, unknown>).tier).toBe("mid");
    expect((revision.afterConfig as Record<string, unknown>).tier).toBe("principal");

    const rolledBack = await svc.rollbackConfigRevision(created.id, revision.id, {});
    expect(rolledBack?.tier).toBe("principal");
  });

  it("records no revision when the tier is unchanged", async () => {
    const cid = await createCompany();
    const svc = agentService(db);

    const created = await svc.create(cid, {
      name: "Stable",
      role: "engineer",
      tier: "senior",
      adapterType: "process",
    });

    await svc.update(created.id, { tier: "senior" }, { recordRevision: { source: "patch" } });

    const revisions = await svc.listConfigRevisions(created.id);
    expect(revisions).toHaveLength(0);
  });
});
