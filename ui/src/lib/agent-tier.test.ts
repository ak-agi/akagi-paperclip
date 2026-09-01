// @vitest-environment node

import { describe, expect, it } from "vitest";
import { agentTierLabel, agentTierRoleLabel } from "./agent-tier";

describe("agentTierLabel", () => {
  it("labels a declared tier", () => {
    expect(agentTierLabel("principal")).toBe("Principal");
    expect(agentTierLabel("junior")).toBe("Junior");
  });

  it("renders nothing when no tier is declared", () => {
    expect(agentTierLabel(null)).toBeNull();
    expect(agentTierLabel(undefined)).toBeNull();
    expect(agentTierLabel("")).toBeNull();
  });

  it("falls back to the raw value for an unknown tier", () => {
    expect(agentTierLabel("staff")).toBe("staff");
  });
});

describe("agentTierRoleLabel", () => {
  it("prefixes the role with the tier", () => {
    expect(agentTierRoleLabel({ role: "engineer", tier: "senior" })).toBe("Senior Engineer");
  });

  it("shows the plain role label when no tier is declared", () => {
    expect(agentTierRoleLabel({ role: "engineer", tier: null })).toBe("Engineer");
    expect(agentTierRoleLabel({ role: "engineer" })).toBe("Engineer");
  });

  it("falls back to the raw role for an unknown role", () => {
    expect(agentTierRoleLabel({ role: "gardener", tier: null })).toBe("gardener");
  });
});
