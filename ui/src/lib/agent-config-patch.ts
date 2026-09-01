import { ADAPTER_AGNOSTIC_KEYS, type Agent, type ModelProfileKey } from "@paperclipai/shared";

export interface AgentModelProfileOverlay {
  enabled?: boolean;
  adapterConfig?: Record<string, unknown>;
  /**
   * Drop this lane's adapter-specific settings (a model id belongs to one
   * adapter) WITHOUT touching its on/off switch.
   *
   * This used to delete the whole `runtimeConfig.modelProfiles.<lane>` entry.
   * An absent entry reads as ENABLED at dispatch, so switching an agent's
   * adapter type silently re-enabled every work lane the operator had turned
   * off. The switch is the operator's cost control and is not adapter-specific,
   * so it survives the adapter change; only `adapterConfig` is reset.
   */
  resetAdapterConfig?: boolean;
}

export interface AgentConfigOverlay {
  identity: Record<string, unknown>;
  adapterType?: string;
  adapterConfig: Record<string, unknown>;
  heartbeat: Record<string, unknown>;
  runtime: Record<string, unknown>;
  /**
   * Every lane in the ladder, not only `cheap`. A cheap-only overlay made the
   * work lanes unreachable from the board, so an operator had no way to switch
   * off a lane that an issue override could already request.
   */
  modelProfiles?: Partial<Record<ModelProfileKey, AgentModelProfileOverlay>>;
}

export function omitUndefinedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  );
}

export function buildAgentUpdatePatch(agent: Agent, overlay: AgentConfigOverlay) {
  const patch: Record<string, unknown> = {};

  if (Object.keys(overlay.identity).length > 0) {
    Object.assign(patch, overlay.identity);
  }

  if (overlay.adapterType !== undefined) {
    patch.adapterType = overlay.adapterType;
  }

  if (overlay.adapterType !== undefined || Object.keys(overlay.adapterConfig).length > 0) {
    const existing = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const nextAdapterConfig =
      overlay.adapterType !== undefined
        ? {
            ...Object.fromEntries(
              ADAPTER_AGNOSTIC_KEYS
                .filter((key) => existing[key] !== undefined)
                .map((key) => [key, existing[key]]),
            ),
            ...overlay.adapterConfig,
          }
        : {
            ...existing,
            ...overlay.adapterConfig,
          };

    patch.adapterConfig = omitUndefinedEntries(nextAdapterConfig);
    patch.replaceAdapterConfig = true;
  }

  const modelProfileOverlayEntries = Object.entries(overlay.modelProfiles ?? {})
    .filter((entry): entry is [string, AgentModelProfileOverlay] => entry[1] !== undefined);
  const hasModelProfileChange = modelProfileOverlayEntries.length > 0;

  if (Object.keys(overlay.heartbeat).length > 0 || hasModelProfileChange) {
    const existingRc = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
    const nextRuntimeConfig: Record<string, unknown> = (patch.runtimeConfig as Record<string, unknown> | undefined)
      ?? { ...existingRc };

    if (Object.keys(overlay.heartbeat).length > 0) {
      const existingHb = (existingRc.heartbeat ?? {}) as Record<string, unknown>;
      nextRuntimeConfig.heartbeat = { ...existingHb, ...overlay.heartbeat };
    }

    if (hasModelProfileChange) {
      const existingProfiles = ((existingRc.modelProfiles ?? {}) as Record<string, unknown>);
      const nextProfiles = { ...existingProfiles };

      for (const [profileKey, profileOverlay] of modelProfileOverlayEntries) {
        const existingProfile = ((existingProfiles[profileKey] ?? {}) as Record<string, unknown>);
        if (profileOverlay.resetAdapterConfig) {
          // A lane the agent never had an entry for stays absent. Writing
          // `{ enabled: true }` here would turn an implicit default into an
          // explicit enable that the operator never asked for.
          if (existingProfiles[profileKey] === undefined) {
            delete nextProfiles[profileKey];
            continue;
          }
          nextProfiles[profileKey] = {
            ...existingProfile,
            enabled: existingProfile.enabled !== false,
            adapterConfig: {},
          };
          continue;
        }
        const mergedAdapterConfig = {
          ...((existingProfile.adapterConfig ?? {}) as Record<string, unknown>),
          ...(profileOverlay.adapterConfig ?? {}),
        };
        const enabled = profileOverlay.enabled ?? (existingProfile.enabled !== false);
        nextProfiles[profileKey] = {
          ...existingProfile,
          enabled,
          adapterConfig: mergedAdapterConfig,
        };
      }

      if (Object.keys(nextProfiles).length === 0) {
        delete nextRuntimeConfig.modelProfiles;
      } else {
        nextRuntimeConfig.modelProfiles = nextProfiles;
      }
    }

    patch.runtimeConfig = nextRuntimeConfig;
  }

  if (Object.keys(overlay.runtime).length > 0) {
    Object.assign(patch, overlay.runtime);
  }

  return patch;
}
