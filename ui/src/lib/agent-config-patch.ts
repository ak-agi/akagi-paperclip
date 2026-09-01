import { ADAPTER_AGNOSTIC_KEYS, type Agent, type ModelProfileKey } from "@paperclipai/shared";

export interface AgentModelProfileOverlay {
  enabled?: boolean;
  adapterConfig?: Record<string, unknown>;
  /**
   * Mark this lane for clearing. When true, the patch removes
   * `runtimeConfig.modelProfiles.<lane>` instead of merging into it.
   */
  cleared?: boolean;
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
        if (profileOverlay.cleared) {
          delete nextProfiles[profileKey];
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
