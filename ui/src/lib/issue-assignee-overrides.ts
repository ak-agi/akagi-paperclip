import { MODEL_PROFILE_KEYS, type ModelProfileKey } from "@paperclipai/shared";

export const ISSUE_OVERRIDE_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "opencode_local",
]);

/**
 * Selectable lanes in the issue model-lane picker.
 *
 * `primary` and `custom` are UI-only pseudo-lanes. Everything between them is a
 * real `modelProfile` key:
 * - `cheap` is the recovery lane. It stays status-only per
 *   `doc/execution-semantics.md` §9.3 and never performs deliverable work.
 * - `senior` / `mid` / `junior` are work lanes and do permit deliverable work.
 */
export type IssueModelLane = "primary" | ModelProfileKey | "custom";

export const ISSUE_MODEL_PROFILE_LANES = MODEL_PROFILE_KEYS;

export const ISSUE_MODEL_LANE_LABELS: Record<ModelProfileKey, string> = {
  cheap: "Cheap",
  senior: "Senior",
  mid: "Mid",
  junior: "Junior",
};

/** Work lanes first, most to least capable; the recovery lane sits last. */
export const ISSUE_MODEL_LANE_DISPLAY_ORDER = [
  "senior",
  "mid",
  "junior",
  "cheap",
] as const satisfies readonly ModelProfileKey[];

/** Lane picked when the operator switches to the lane group without a lane set. */
export const ISSUE_DEFAULT_MODEL_PROFILE_LANE: ModelProfileKey = "mid";

export const ISSUE_MODEL_LANE_HINTS: Record<ModelProfileKey, string> = {
  senior: "Work lane for hard or ambiguous tasks.",
  mid: "Work lane for ordinary well-specified tasks.",
  junior: "Work lane for narrow, fully specified tasks.",
  cheap: "Recovery lane — status-only coordination, not deliverable work.",
};

export function isIssueModelProfileLane(lane: IssueModelLane): lane is ModelProfileKey {
  return (MODEL_PROFILE_KEYS as readonly string[]).includes(lane);
}

export interface BuildAssigneeAdapterOverridesInput {
  adapterType: string | null | undefined;
  lane: IssueModelLane;
  modelOverride: string;
  thinkingEffortOverride: string;
  chrome: boolean;
}

/**
 * Build the `assigneeAdapterOverrides` payload sent to the issue create API.
 *
 * Lane semantics:
 * - "primary" → no overrides, runs on the agent's primary model.
 * - a model profile key ("cheap" | "senior" | "mid" | "junior")
 *             → `modelProfile: <key>` only; the runtime resolves the actual
 *               adapter config from the agent's runtimeConfig + adapter default,
 *               and degrades to the primary model when the adapter does not
 *               declare that lane.
 * - "custom"  → preserves the legacy explicit override path
 *               (`adapterConfig.model`, thinking effort, chrome).
 */
export function buildAssigneeAdapterOverrides(
  input: BuildAssigneeAdapterOverridesInput,
): Record<string, unknown> | null {
  const adapterType = input.adapterType ?? null;
  if (!adapterType || !ISSUE_OVERRIDE_ADAPTER_TYPES.has(adapterType)) {
    return null;
  }

  if (input.lane === "primary") {
    return null;
  }

  if (isIssueModelProfileLane(input.lane)) {
    return { modelProfile: input.lane };
  }

  const adapterConfig: Record<string, unknown> = {};
  if (input.modelOverride) adapterConfig.model = input.modelOverride;
  if (input.thinkingEffortOverride) {
    if (adapterType === "codex_local") {
      adapterConfig.modelReasoningEffort = input.thinkingEffortOverride;
    } else if (adapterType === "opencode_local") {
      adapterConfig.variant = input.thinkingEffortOverride;
    } else if (adapterType === "claude_local") {
      adapterConfig.effort = input.thinkingEffortOverride;
    }
  }
  if (adapterType === "claude_local" && input.chrome) {
    adapterConfig.chrome = true;
  }

  if (Object.keys(adapterConfig).length === 0) return null;
  return { adapterConfig };
}
