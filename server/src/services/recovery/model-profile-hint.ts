import { RECOVERY_MODEL_PROFILE_KEY } from "@paperclipai/shared";

// Re-exported so recovery callers keep importing the lane key from the recovery
// module, while the literal itself is declared exactly once in
// `@paperclipai/shared`. Two independent `"cheap"` literals is precisely the
// drift this module exists to prevent.
export { RECOVERY_MODEL_PROFILE_KEY };

export type RecoveryModelProfileWorkClass = "status_only" | "normal_model";

export const STATUS_ONLY_RECOVERY_GUARD_CONTEXT = {
  recoveryIntent: "status_only",
  allowDeliverableWork: false,
  allowDocumentUpdates: false,
  resumeRequiresNormalModel: true,
} as const;

/**
 * True when a run context carries the §9.3 status-only recovery guards.
 *
 * Keyed off `recoveryIntent` and the three guard flags — deliberately NOT off
 * `context.modelProfile`. Dispatch rewrites `context.modelProfile` to whatever
 * lane won model-profile resolution (`resolveModelProfileApplication`) and
 * persists it back to `heartbeat_runs.context_snapshot`, so a guard that keys
 * off the lane key can be switched off by an unrelated per-issue
 * `assigneeAdapterOverrides.modelProfile`. The guard flags below are never
 * rewritten by dispatch, so they are the durable signal.
 */
export function isStatusOnlyRecoveryGuardContext(contextSnapshot: unknown): boolean {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return false;
  const context = contextSnapshot as Record<string, unknown>;
  return context.recoveryIntent === STATUS_ONLY_RECOVERY_GUARD_CONTEXT.recoveryIntent &&
    context.allowDeliverableWork === STATUS_ONLY_RECOVERY_GUARD_CONTEXT.allowDeliverableWork &&
    context.allowDocumentUpdates === STATUS_ONLY_RECOVERY_GUARD_CONTEXT.allowDocumentUpdates &&
    context.resumeRequiresNormalModel === STATUS_ONLY_RECOVERY_GUARD_CONTEXT.resumeRequiresNormalModel;
}

const RECOVERY_MODEL_PROFILE_HINT_KEYS = [
  "modelProfile",
  "paperclipModelProfile",
  "recoveryIntent",
  "allowDeliverableWork",
  "allowDocumentUpdates",
  "resumeRequiresNormalModel",
] as const;

type RecoveryModelProfileHintKey = (typeof RECOVERY_MODEL_PROFILE_HINT_KEYS)[number];
type WithoutRecoveryModelProfileHints<T> = Omit<T, RecoveryModelProfileHintKey>;

export function scrubRecoveryModelProfileHints<T extends Record<string, unknown>>(
  input: T,
): WithoutRecoveryModelProfileHints<T> {
  const output: Record<string, unknown> = { ...input };
  for (const key of RECOVERY_MODEL_PROFILE_HINT_KEYS) {
    delete output[key];
  }
  return output as WithoutRecoveryModelProfileHints<T>;
}

export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "normal_model",
): WithoutRecoveryModelProfileHints<T>;
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: "status_only",
): WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
  modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
};
export function withRecoveryModelProfileHint<T extends Record<string, unknown>>(
  input: T,
  workClass: RecoveryModelProfileWorkClass,
):
  | WithoutRecoveryModelProfileHints<T>
  | (WithoutRecoveryModelProfileHints<T> & typeof STATUS_ONLY_RECOVERY_GUARD_CONTEXT & {
    modelProfile: typeof RECOVERY_MODEL_PROFILE_KEY;
  }) {
  if (workClass === "normal_model") {
    return scrubRecoveryModelProfileHints(input);
  }

  return {
    ...scrubRecoveryModelProfileHints(input),
    ...STATUS_ONLY_RECOVERY_GUARD_CONTEXT,
    modelProfile: RECOVERY_MODEL_PROFILE_KEY,
  };
}

export function recoveryAssigneeAdapterOverrides(_workClass: Extract<RecoveryModelProfileWorkClass, "status_only">) {
  return { modelProfile: RECOVERY_MODEL_PROFILE_KEY };
}
