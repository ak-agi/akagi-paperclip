import {
  WORK_MODEL_PROFILE_KEYS,
  type ModelProfileKey,
  type WorkModelProfileKey,
} from "./constants.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function hasOwn(value: UnknownRecord, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function readModelProfiles(runtimeConfig: unknown): UnknownRecord {
  return asRecord(asRecord(runtimeConfig)?.modelProfiles) ?? {};
}

/**
 * The effective lane state a dispatch would read.
 *
 * This mirrors `readAgentRuntimeModelProfile()` in `server/src/services/heartbeat.ts`:
 * an ABSENT entry reads as ENABLED. That default is what makes deletion an
 * escalation — dropping `runtimeConfig.modelProfiles.senior` turns the senior
 * lane back on. Every governance decision below is expressed against this
 * effective view rather than against the keys a request happens to carry, so
 * omission is compared the same way an explicit write is.
 */
export interface EffectiveModelProfileState {
  enabled: boolean;
  adapterConfig: UnknownRecord;
}

export function readEffectiveModelProfile(
  runtimeConfig: unknown,
  key: ModelProfileKey,
): EffectiveModelProfileState {
  const profile = asRecord(readModelProfiles(runtimeConfig)[key]);
  if (!profile || Object.keys(profile).length === 0) {
    return { enabled: true, adapterConfig: {} };
  }
  return {
    enabled: profile.enabled !== false,
    adapterConfig: asRecord(profile.adapterConfig) ?? {},
  };
}

function sameEffectiveModelProfile(
  a: EffectiveModelProfileState,
  b: EffectiveModelProfileState,
) {
  return a.enabled === b.enabled
    && JSON.stringify(a.adapterConfig) === JSON.stringify(b.adapterConfig);
}

/**
 * Work lanes whose EFFECTIVE state differs between two runtime configs.
 *
 * Deletion by omission shows up here: if `before` disabled `senior` and
 * `after` has no `senior` entry at all, the effective states are
 * `enabled: false` and `enabled: true`, so the lane is reported as changed.
 */
export function changedWorkModelProfileKeys(
  before: unknown,
  after: unknown,
): WorkModelProfileKey[] {
  return WORK_MODEL_PROFILE_KEYS.filter((key) =>
    !sameEffectiveModelProfile(
      readEffectiveModelProfile(before, key),
      readEffectiveModelProfile(after, key),
    ),
  );
}

/** Work lane keys a request payload names outright. */
export function writtenWorkModelProfileKeys(runtimeConfig: unknown): WorkModelProfileKey[] {
  const modelProfiles = readModelProfiles(runtimeConfig);
  return WORK_MODEL_PROFILE_KEYS.filter((key) => hasOwn(modelProfiles, key));
}

/**
 * Seed `{ enabled: false }` for every work lane the runtime config does not
 * already carry. Absent means enabled downstream, so an agent created (or a
 * revision restored) with no entry runs whatever lane a requester asks for.
 *
 * This is deliberately adapter-independent. Keying the seed off "the adapter
 * declares model profiles today" left a hole: an adapter that declares none at
 * create time seeded nothing, so every agent created under it gained all three
 * work lanes the moment that adapter later declared one.
 */
export function seedDisabledWorkModelProfiles(runtimeConfig: unknown): UnknownRecord {
  const next = { ...(asRecord(runtimeConfig) ?? {}) };
  const modelProfiles = { ...readModelProfiles(next) };
  for (const key of WORK_MODEL_PROFILE_KEYS) {
    if (!hasOwn(modelProfiles, key)) modelProfiles[key] = { enabled: false };
  }
  next.modelProfiles = modelProfiles;
  return next;
}

/**
 * Force every work lane off, discarding whatever the input declared.
 *
 * Used where the caller supplies the whole payload and nothing about it was
 * vetted by an operator — the `agent_safe` company import. Filling only the
 * ABSENT lanes there is not a control: the caller simply declares the lane it
 * wants, enabled, on the model it picked.
 */
export function forceDisabledWorkModelProfiles(runtimeConfig: unknown): UnknownRecord {
  const next = { ...(asRecord(runtimeConfig) ?? {}) };
  const modelProfiles = { ...readModelProfiles(next) };
  for (const key of WORK_MODEL_PROFILE_KEYS) {
    modelProfiles[key] = { enabled: false };
  }
  next.modelProfiles = modelProfiles;
  return next;
}

/**
 * Reconcile a replacement `runtimeConfig` against the stored one so that
 * omitting a lane is not the same as re-enabling it.
 *
 * `PATCH /api/agents/:id` replaces `runtimeConfig` wholesale. Combined with
 * "absent means enabled", that made every stored lane switch a write away from
 * being deleted — by an agent editing its own config (`assertCanUpdateAgent`
 * is a self-allow), and by a board CLI caller sending a partial lane map.
 *
 * The `modelProfiles` subtree is therefore merged rather than replaced:
 *  - a lane the request names wins, so a lane stays writable;
 *  - a lane the request omits keeps its stored entry.
 *
 * One rule, and it is the whole rule: the lane map is never REDUCED by a write.
 * It changes only through an explicit named lane entry, which is visible in the
 * activity log. Nothing becomes inexpressible -- re-enabling a lane is
 * `{ enabled: true }`.
 *
 * This deliberately does NOT seed absent lanes. Seeding on the update path
 * would silently disable the work lanes of every already-deployed agent the
 * first time anyone saved an unrelated runtime setting, while the board form
 * still showed those lanes as on. Backfilling the deployed fleet is a separate
 * operator decision; see `doc/SPEC-implementation.md` 11.5.4.
 */
export function mergeStoredModelProfiles(
  storedRuntimeConfig: unknown,
  requestedRuntimeConfig: unknown,
): UnknownRecord {
  const next = { ...(asRecord(requestedRuntimeConfig) ?? {}) };
  const requestedProfiles = readModelProfiles(next);
  const storedProfiles = readModelProfiles(storedRuntimeConfig);
  const merged: UnknownRecord = { ...requestedProfiles };
  for (const [key, value] of Object.entries(storedProfiles)) {
    if (!hasOwn(merged, key)) merged[key] = value;
  }
  if (Object.keys(merged).length > 0) next.modelProfiles = merged;
  return next;
}
