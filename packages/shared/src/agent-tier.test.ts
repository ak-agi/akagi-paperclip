import { describe, expect, it } from "vitest";
import {
  AGENT_TIERS,
  AGENT_TIER_LABELS,
  AGENT_TIER_MODEL_PROFILES,
  AGENT_TIER_RANKS,
  RECOVERY_MODEL_PROFILE_KEY,
  agentTierModelProfile,
  agentTierRank,
  isAgentTier,
  isWorkModelProfileKey,
} from "./constants.js";
import { createAgentSchema, updateAgentSchema } from "./validators/agent.js";

describe("agent tier taxonomy", () => {
  it("orders the tiers from most to least capable", () => {
    expect(AGENT_TIERS).toEqual(["principal", "senior", "mid", "junior"]);
  });

  it("labels every tier", () => {
    for (const tier of AGENT_TIERS) {
      expect(AGENT_TIER_LABELS[tier]).toBeTruthy();
    }
    expect(AGENT_TIER_LABELS.principal).toBe("Principal");
    expect(AGENT_TIER_LABELS.junior).toBe("Junior");
  });

  it("ranks principal highest and junior lowest", () => {
    expect(AGENT_TIER_RANKS).toEqual({ principal: 0, senior: 1, mid: 2, junior: 3 });
    const ranked = [...AGENT_TIERS].sort((a, b) => AGENT_TIER_RANKS[b] - AGENT_TIER_RANKS[a]);
    expect(ranked).toEqual(["junior", "mid", "senior", "principal"]);
  });
});

describe("agentTierRank", () => {
  it("returns the rank for a declared tier", () => {
    expect(agentTierRank("principal")).toBe(0);
    expect(agentTierRank("junior")).toBe(3);
  });

  it("returns null when no tier is declared", () => {
    expect(agentTierRank(null)).toBeNull();
    expect(agentTierRank(undefined)).toBeNull();
  });

  it("returns null for an unknown tier instead of guessing a rank", () => {
    expect(agentTierRank("staff")).toBeNull();
  });

  it("compares seniority without comparing tier strings", () => {
    const seniorRank = agentTierRank("senior")!;
    const midRank = agentTierRank("mid")!;
    expect(seniorRank).toBeLessThan(midRank);
  });
});

describe("isAgentTier", () => {
  it("accepts every declared tier", () => {
    for (const tier of AGENT_TIERS) {
      expect(isAgentTier(tier)).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(isAgentTier("staff")).toBe(false);
    expect(isAgentTier("")).toBe(false);
    expect(isAgentTier(null)).toBe(false);
    expect(isAgentTier(undefined)).toBe(false);
    expect(isAgentTier(0)).toBe(false);
  });
});

describe("agent validators tier field", () => {
  const baseCreate = { name: "Coder", adapterType: "process" as const };

  it("accepts a create payload with a declared tier", () => {
    const parsed = createAgentSchema.parse({ ...baseCreate, tier: "senior" });
    expect(parsed.tier).toBe("senior");
  });

  it("accepts an explicit null tier", () => {
    const parsed = createAgentSchema.parse({ ...baseCreate, tier: null });
    expect(parsed.tier).toBeNull();
  });

  it("leaves the tier undefined when it is omitted, so no tier is declared", () => {
    const parsed = createAgentSchema.parse(baseCreate);
    expect(parsed.tier).toBeUndefined();
  });

  it("rejects a tier outside the taxonomy", () => {
    const result = createAgentSchema.safeParse({ ...baseCreate, tier: "staff" });
    expect(result.success).toBe(false);
  });

  it("accepts a tier-only update and rejects an invalid one", () => {
    expect(updateAgentSchema.parse({ tier: "junior" }).tier).toBe("junior");
    expect(updateAgentSchema.parse({ tier: null }).tier).toBeNull();
    expect(updateAgentSchema.safeParse({ tier: "intern" }).success).toBe(false);
  });
});

describe("agentTierModelProfile", () => {
  it("maps each work tier to the same-named work lane", () => {
    expect(agentTierModelProfile("senior")).toBe("senior");
    expect(agentTierModelProfile("mid")).toBe("mid");
    expect(agentTierModelProfile("junior")).toBe("junior");
  });

  it("gives principal no lane, so it keeps its configured primary model", () => {
    expect(agentTierModelProfile("principal")).toBeNull();
    expect(AGENT_TIER_MODEL_PROFILES.principal).toBeNull();
  });

  it("gives an undeclared tier no lane", () => {
    expect(agentTierModelProfile(null)).toBeNull();
    expect(agentTierModelProfile(undefined)).toBeNull();
  });

  it("gives an unknown tier no lane instead of guessing one", () => {
    expect(agentTierModelProfile("staff")).toBeNull();
    expect(agentTierModelProfile("")).toBeNull();
  });

  it("never reaches the reserved recovery lane from any tier", () => {
    for (const tier of AGENT_TIERS) {
      const lane = agentTierModelProfile(tier);
      expect(lane).not.toBe(RECOVERY_MODEL_PROFILE_KEY);
      if (lane !== null) expect(isWorkModelProfileKey(lane)).toBe(true);
    }
  });

  it("declares a lane for every tier in the taxonomy", () => {
    expect(Object.keys(AGENT_TIER_MODEL_PROFILES).sort()).toEqual([...AGENT_TIERS].sort());
  });
});
