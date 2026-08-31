import { describe, expect, it } from "vitest";
import {
  listAdapterModelProfiles,
  type AdapterModelProfileDefinition,
} from "../adapters/index.js";
import {
  mergeModelProfileAdapterConfig,
  normalizeModelProfileWakeContext,
  resolveModelProfileApplication,
  isConfigurationIncompleteFailedRun,
} from "../services/heartbeat.ts";

const cheapProfile: AdapterModelProfileDefinition = {
  key: "cheap",
  label: "Cheap",
  adapterConfig: {
    model: "adapter-cheap",
    modelReasoningEffort: "low",
  },
  source: "adapter_default",
};

describe("heartbeat model profile application", () => {
  it("keeps Codex on its primary model when cheap has no explicit model override", async () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: await listAdapterModelProfiles("codex_local"),
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: { model: "primary" },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
      adapterConfig: {},
    });
    expect(merged).toEqual({ model: "primary" });
  });

  it("applies cheap profile patches before explicit issue adapter config overrides", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {},
      issueModelProfile: "cheap",
      contextSnapshot: {},
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
        modelReasoningEffort: "high",
        approvalPolicy: "strict",
      },
      modelProfile,
      issueAdapterConfig: {
        model: "issue-explicit",
      },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "issue_override",
      applied: "cheap",
      configSource: "adapter_default",
      fallbackReason: null,
    });
    expect(merged).toEqual({
      model: "issue-explicit",
      modelReasoningEffort: "low",
      approvalPolicy: "strict",
    });
  });

  it("lets agent runtime profile config customize adapter defaults", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [cheapProfile],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      requestedBy: "wake_context",
      applied: "cheap",
      configSource: "agent_runtime",
      adapterConfig: {
        model: "agent-cheap",
        modelReasoningEffort: "low",
      },
    });
  });

  it("falls back to the primary config when the adapter does not support the requested profile", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {
        modelProfiles: {
          cheap: {
            adapterConfig: {
              model: "agent-cheap",
            },
          },
        },
      },
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "cheap" },
    });

    const merged = mergeModelProfileAdapterConfig({
      baseConfig: {
        model: "primary",
      },
      modelProfile,
      issueAdapterConfig: null,
    });

    expect(modelProfile).toMatchObject({
      requested: "cheap",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      adapterConfig: null,
    });
    expect(merged).toEqual({ model: "primary" });
  });

  it("normalizes a wake payload model profile into run context", () => {
    const contextSnapshot = normalizeModelProfileWakeContext({
      contextSnapshot: {},
      payload: { modelProfile: "cheap" },
    });

    expect(contextSnapshot).toMatchObject({ modelProfile: "cheap" });
  });

  it.each(["claude_local", "codex_local", "opencode_local"] as const)(
    "%s declares every work lane and applies it as a normal work run",
    async (adapterType) => {
      const adapterModelProfiles = await listAdapterModelProfiles(adapterType);
      const declaredKeys = adapterModelProfiles.map((profile) => profile.key);
      expect(declaredKeys).toEqual(expect.arrayContaining(["cheap", "senior", "mid", "junior"]));

      for (const lane of ["senior", "mid", "junior"] as const) {
        const modelProfile = resolveModelProfileApplication({
          adapterModelProfiles,
          agentRuntimeConfig: {},
          issueModelProfile: lane,
          contextSnapshot: {},
        });

        expect(modelProfile).toMatchObject({
          requested: lane,
          requestedBy: "issue_override",
          applied: lane,
          configSource: "adapter_default",
          fallbackReason: null,
        });
        // Work lanes carry a concrete model, unlike the Codex recovery lane
        // which intentionally stays on the agent's primary model.
        expect(typeof modelProfile.adapterConfig?.model).toBe("string");
      }
    },
  );

  it.each(["senior", "mid", "junior"] as const)(
    "degrades the %s work lane to the primary model when the adapter does not declare it",
    (lane) => {
      const modelProfile = resolveModelProfileApplication({
        // Only the recovery lane is declared; the requested work lane is absent.
        adapterModelProfiles: [cheapProfile],
        agentRuntimeConfig: {},
        issueModelProfile: lane,
        contextSnapshot: {},
      });

      const merged = mergeModelProfileAdapterConfig({
        baseConfig: { model: "primary", modelReasoningEffort: "high" },
        modelProfile,
        issueAdapterConfig: null,
      });

      expect(modelProfile).toMatchObject({
        requested: lane,
        requestedBy: "issue_override",
        applied: null,
        configSource: null,
        fallbackReason: "adapter_profile_not_supported",
        adapterConfig: null,
      });
      // Graceful degradation: no throw, and the primary config is untouched.
      expect(merged).toEqual({ model: "primary", modelReasoningEffort: "high" });
    },
  );

  it("degrades a work lane requested through wake context without throwing", () => {
    const modelProfile = resolveModelProfileApplication({
      adapterModelProfiles: [],
      agentRuntimeConfig: {},
      issueModelProfile: null,
      contextSnapshot: { modelProfile: "junior" },
    });

    expect(modelProfile).toMatchObject({
      requested: "junior",
      requestedBy: "wake_context",
      applied: null,
      fallbackReason: "adapter_profile_not_supported",
      adapterConfig: null,
    });
  });

  it("honours an agent runtime override for a work lane and its disabled flag", () => {
    const seniorProfile: AdapterModelProfileDefinition = {
      key: "senior",
      label: "Senior",
      adapterConfig: { model: "adapter-senior", effort: "medium" },
      source: "adapter_default",
    };

    expect(
      resolveModelProfileApplication({
        adapterModelProfiles: [seniorProfile],
        agentRuntimeConfig: { modelProfiles: { senior: { adapterConfig: { model: "agent-senior" } } } },
        issueModelProfile: "senior",
        contextSnapshot: {},
      }),
    ).toMatchObject({
      applied: "senior",
      configSource: "agent_runtime",
      adapterConfig: { model: "agent-senior", effort: "medium" },
    });

    expect(
      resolveModelProfileApplication({
        adapterModelProfiles: [seniorProfile],
        agentRuntimeConfig: { modelProfiles: { senior: { enabled: false } } },
        issueModelProfile: "senior",
        contextSnapshot: {},
      }),
    ).toMatchObject({
      applied: null,
      fallbackReason: "agent_runtime_profile_disabled",
      adapterConfig: null,
    });
  });

  it("keeps the recovery lane separate from the work lanes", () => {
    // `cheap` is the recovery lane: requesting a work lane must never resolve to
    // it, and requesting `cheap` must never resolve to a work lane.
    const profiles: AdapterModelProfileDefinition[] = [
      cheapProfile,
      { key: "mid", label: "Mid", adapterConfig: { model: "adapter-mid" }, source: "adapter_default" },
    ];

    expect(
      resolveModelProfileApplication({
        adapterModelProfiles: profiles,
        agentRuntimeConfig: {},
        issueModelProfile: "mid",
        contextSnapshot: {},
      }),
    ).toMatchObject({ applied: "mid", adapterConfig: { model: "adapter-mid" } });

    expect(
      resolveModelProfileApplication({
        adapterModelProfiles: profiles,
        agentRuntimeConfig: {},
        issueModelProfile: "cheap",
        contextSnapshot: {},
      }),
    ).toMatchObject({ applied: "cheap", adapterConfig: { model: "adapter-cheap" } });
  });

  it("treats model resolution failures as non-retryable configuration failures", () => {
    expect(isConfigurationIncompleteFailedRun({ errorCode: "model_not_found" })).toBe(true);
    expect(isConfigurationIncompleteFailedRun({ errorCode: "provider_quota" })).toBe(false);
  });
});
