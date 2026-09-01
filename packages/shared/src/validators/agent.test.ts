import { describe, expect, it } from "vitest";
import { WORK_MODEL_PROFILE_KEYS } from "../constants.js";
import { agentRuntimeConfigSchema, createAgentSchema, updateAgentSchema } from "./agent.js";

describe("agentRuntimeConfigSchema model profiles", () => {
  it("accepts the reserved cheap recovery lane", () => {
    const parsed = agentRuntimeConfigSchema.safeParse({
      modelProfiles: {
        cheap: { enabled: false, adapterConfig: { model: "claude-haiku-4-5" } },
      },
    });

    expect(parsed.success).toBe(true);
  });

  it.each(WORK_MODEL_PROFILE_KEYS)("accepts a disabled %s work lane", (key) => {
    const parsed = agentRuntimeConfigSchema.safeParse({
      modelProfiles: {
        [key]: { enabled: false, adapterConfig: {} },
      },
    });

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("accepts every lane at once", () => {
    const parsed = agentRuntimeConfigSchema.safeParse({
      modelProfiles: {
        cheap: { enabled: false, adapterConfig: {} },
        senior: { enabled: false, adapterConfig: {} },
        mid: { enabled: true, adapterConfig: { model: "sonnet" } },
        junior: { enabled: true, adapterConfig: { model: "haiku" } },
      },
    });

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("still rejects a lane key that is not part of the ladder", () => {
    const parsed = agentRuntimeConfigSchema.safeParse({
      modelProfiles: {
        principal: { enabled: true, adapterConfig: {} },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a lane switched off with no adapter config", () => {
    // The kill switch must be expressible on its own. Requiring an
    // `adapterConfig` to turn a lane off would make the disable path harder to
    // reach than the enable path.
    const parsed = agentRuntimeConfigSchema.safeParse({
      modelProfiles: { senior: { enabled: false } },
    });

    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("carries the work lanes through agent create and update payloads", () => {
    const created = createAgentSchema.safeParse({
      name: "Builder",
      adapterType: "claude_local",
      runtimeConfig: { modelProfiles: { senior: { enabled: false, adapterConfig: {} } } },
    });
    expect(created.success, JSON.stringify(created.error?.issues)).toBe(true);

    const updated = updateAgentSchema.safeParse({
      runtimeConfig: { modelProfiles: { junior: { enabled: true, adapterConfig: { model: "haiku" } } } },
    });
    expect(updated.success, JSON.stringify(updated.error?.issues)).toBe(true);
  });
});
