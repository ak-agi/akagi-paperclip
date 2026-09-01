import { AGENT_ROLE_LABELS, AGENT_TIER_LABELS } from "@paperclipai/shared";

export const tierLabels = AGENT_TIER_LABELS as Record<string, string>;

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/**
 * Display label for an agent's seniority tier, or `null` when the agent
 * declares no tier. An undeclared tier renders nothing rather than a
 * placeholder, so untiered agents look exactly as they did before tiers.
 */
export function agentTierLabel(tier: string | null | undefined): string | null {
  if (!tier) return null;
  return tierLabels[tier] ?? tier;
}

/**
 * Combined seniority + role label, e.g. "Senior Engineer". Falls back to the
 * plain role label when no tier is declared.
 */
export function agentTierRoleLabel(agent: { role: string; tier?: string | null }): string {
  const role = roleLabels[agent.role] ?? agent.role;
  const tier = agentTierLabel(agent.tier);
  return tier ? `${tier} ${role}` : role;
}
