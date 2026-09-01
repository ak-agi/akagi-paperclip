import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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
    `Skipping embedded Postgres agent work lane tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function modelProfilesOf(runtimeConfig: unknown) {
  return (runtimeConfig as Record<string, unknown> | null)?.modelProfiles;
}

describeEmbeddedPostgres("agent service work lane defaults", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-work-lane-");
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
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  // FINDING 5: only two of five create paths seeded the work lanes. Join-request
  // approval (`routes/access.ts`, gated on the grantable `joins:approve`
  // permission) and both built-in agent provisioning paths passed
  // `runtimeConfig: {}` straight through, and an absent lane entry reads as
  // ENABLED at dispatch. The seed now sits at the one choke point every create
  // path goes through, so this asserts the service, not a route.
  it("seeds every work lane off for an agent created with an empty runtime config", async () => {
    const companyId = await createCompany();
    const created = await agentService(db).create(companyId, {
      name: "Joined",
      role: "general",
      adapterType: "process",
      runtimeConfig: {},
    });

    expect(modelProfilesOf(created.runtimeConfig)).toEqual({
      senior: { enabled: false },
      mid: { enabled: false },
      junior: { enabled: false },
    });
  });

  it("seeds every work lane off for an agent created with no runtime config at all", async () => {
    const companyId = await createCompany();
    const created = await agentService(db).create(companyId, {
      name: "BuiltIn",
      role: "general",
      adapterType: "process",
    });

    expect(modelProfilesOf(created.runtimeConfig)).toEqual({
      senior: { enabled: false },
      mid: { enabled: false },
      junior: { enabled: false },
    });
  });

  it("leaves a work lane the caller deliberately enabled alone", async () => {
    const companyId = await createCompany();
    const created = await agentService(db).create(companyId, {
      name: "Boarded",
      role: "general",
      adapterType: "process",
      runtimeConfig: {
        modelProfiles: { senior: { enabled: true, adapterConfig: { model: "gpt-5.4" } } },
      },
    });

    expect(modelProfilesOf(created.runtimeConfig)).toEqual({
      senior: { enabled: true, adapterConfig: { model: "gpt-5.4" } },
      mid: { enabled: false },
      junior: { enabled: false },
    });
  });

  // FINDING 4 (service half): the restore rewrites `runtimeConfig` wholesale
  // from the snapshot. A revision captured before the kill switch existed
  // carries no lane entries, so restoring it verbatim switched every work lane
  // back on. The lane map is never reduced by a write.
  it("does not re-enable a disabled work lane when restoring an older revision", async () => {
    const companyId = await createCompany();
    const svc = agentService(db);

    const created = await svc.create(companyId, {
      name: "Restored",
      role: "general",
      adapterType: "process",
    });

    // A revision that predates the kill switch: no lane entries at all.
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 20 } } })
      .where(eq(agents.id, created.id));
    const preSwitch = await svc.update(
      created.id,
      { title: "Before" },
      { recordRevision: { source: "patch" } },
    );
    expect(modelProfilesOf(preSwitch?.runtimeConfig)).toBeUndefined();

    const revisions = await svc.listConfigRevisions(created.id);
    const preSwitchRevision = revisions[0]!;

    // The operator then switches every work lane off.
    await svc.update(created.id, {
      runtimeConfig: {
        heartbeat: { maxConcurrentRuns: 20 },
        modelProfiles: {
          senior: { enabled: false },
          mid: { enabled: false },
          junior: { enabled: false },
        },
      },
    });

    const rolledBack = await svc.rollbackConfigRevision(created.id, preSwitchRevision.id, {});
    expect(modelProfilesOf(rolledBack?.runtimeConfig)).toEqual({
      senior: { enabled: false },
      mid: { enabled: false },
      junior: { enabled: false },
    });
  });

  it("restores a lane the snapshot declares outright", async () => {
    const companyId = await createCompany();
    const svc = agentService(db);

    const created = await svc.create(companyId, {
      name: "Declared",
      role: "general",
      adapterType: "process",
      runtimeConfig: {
        modelProfiles: { senior: { enabled: true, adapterConfig: { model: "gpt-5.4" } } },
      },
    });

    await svc.update(created.id, { title: "Snapshot" }, { recordRevision: { source: "patch" } });
    const revisions = await svc.listConfigRevisions(created.id);
    const enabledRevision = revisions[0]!;

    await svc.update(created.id, {
      runtimeConfig: {
        modelProfiles: {
          senior: { enabled: false },
          mid: { enabled: false },
          junior: { enabled: false },
        },
      },
    });

    const rolledBack = await svc.rollbackConfigRevision(created.id, enabledRevision.id, {});
    expect(modelProfilesOf(rolledBack?.runtimeConfig)).toMatchObject({
      senior: { enabled: true, adapterConfig: { model: "gpt-5.4" } },
    });
  });
});
