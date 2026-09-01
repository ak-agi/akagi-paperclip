import { describe, expect, it } from "vitest";
import { WORK_MODEL_PROFILE_KEYS } from "./constants.js";
import {
  changedWorkModelProfileKeys,
  forceDisabledWorkModelProfiles,
  mergeStoredModelProfiles,
  readEffectiveModelProfile,
  seedDisabledWorkModelProfiles,
  writtenWorkModelProfileKeys,
} from "./model-profile-governance.js";

const allLanesOff = {
  cheap: { enabled: false },
  senior: { enabled: false },
  mid: { enabled: false },
  junior: { enabled: false },
};

describe("readEffectiveModelProfile", () => {
  it("reads an absent lane as enabled, matching dispatch", () => {
    expect(readEffectiveModelProfile({}, "senior")).toEqual({ enabled: true, adapterConfig: {} });
    expect(readEffectiveModelProfile(undefined, "senior")).toEqual({ enabled: true, adapterConfig: {} });
    expect(readEffectiveModelProfile({ modelProfiles: {} }, "senior")).toEqual({
      enabled: true,
      adapterConfig: {},
    });
  });

  it("reads a stored lane as stored", () => {
    expect(
      readEffectiveModelProfile(
        { modelProfiles: { senior: { enabled: false, adapterConfig: { model: "a" } } } },
        "senior",
      ),
    ).toEqual({ enabled: false, adapterConfig: { model: "a" } });
  });
});

describe("changedWorkModelProfileKeys", () => {
  it("reports deletion by omission as a change", () => {
    expect(changedWorkModelProfileKeys({ modelProfiles: allLanesOff }, {})).toEqual([
      ...WORK_MODEL_PROFILE_KEYS,
    ]);
    expect(
      changedWorkModelProfileKeys({ modelProfiles: allLanesOff }, { heartbeat: { enabled: false } }),
    ).toEqual([...WORK_MODEL_PROFILE_KEYS]);
  });

  it("reports an unchanged echo as no change", () => {
    expect(
      changedWorkModelProfileKeys(
        { modelProfiles: allLanesOff },
        { modelProfiles: { ...allLanesOff } },
      ),
    ).toEqual([]);
  });

  it("reports only the lane whose adapter config moved", () => {
    expect(
      changedWorkModelProfileKeys(
        { modelProfiles: { ...allLanesOff, senior: { enabled: false, adapterConfig: { model: "a" } } } },
        { modelProfiles: { ...allLanesOff, senior: { enabled: false, adapterConfig: { model: "b" } } } },
      ),
    ).toEqual(["senior"]);
  });

  it("ignores the reserved cheap recovery lane", () => {
    expect(
      changedWorkModelProfileKeys(
        { modelProfiles: allLanesOff },
        { modelProfiles: { ...allLanesOff, cheap: { enabled: true } } },
      ),
    ).toEqual([]);
  });
});

describe("writtenWorkModelProfileKeys", () => {
  it("lists only work lanes the payload names", () => {
    expect(writtenWorkModelProfileKeys({ modelProfiles: { cheap: {}, mid: {} } })).toEqual(["mid"]);
    expect(writtenWorkModelProfileKeys({})).toEqual([]);
  });
});

describe("seedDisabledWorkModelProfiles", () => {
  it("seeds every absent work lane off regardless of adapter", () => {
    expect(seedDisabledWorkModelProfiles({}).modelProfiles).toEqual({
      senior: { enabled: false },
      mid: { enabled: false },
      junior: { enabled: false },
    });
  });

  it("leaves a declared lane alone", () => {
    expect(
      seedDisabledWorkModelProfiles({ modelProfiles: { senior: { enabled: true } } }).modelProfiles,
    ).toEqual({
      senior: { enabled: true },
      mid: { enabled: false },
      junior: { enabled: false },
    });
  });

  it("does not touch the rest of the runtime config", () => {
    expect(seedDisabledWorkModelProfiles({ heartbeat: { enabled: true } }).heartbeat).toEqual({
      enabled: true,
    });
  });
});

describe("forceDisabledWorkModelProfiles", () => {
  it("overrides a declared work lane instead of only filling absent ones", () => {
    expect(
      forceDisabledWorkModelProfiles({
        modelProfiles: {
          cheap: { enabled: true },
          senior: { enabled: true, adapterConfig: { model: "claude-opus-4-6" } },
        },
      }).modelProfiles,
    ).toEqual({
      cheap: { enabled: true },
      senior: { enabled: false },
      mid: { enabled: false },
      junior: { enabled: false },
    });
  });
});

describe("mergeStoredModelProfiles", () => {
  it("carries stored lanes through a runtime config that omits them", () => {
    expect(
      mergeStoredModelProfiles(
        { modelProfiles: allLanesOff },
        { heartbeat: { enabled: false, maxConcurrentRuns: 3 } },
      ),
    ).toEqual({
      heartbeat: { enabled: false, maxConcurrentRuns: 3 },
      modelProfiles: allLanesOff,
    });
  });

  it("carries stored lanes through an empty runtime config", () => {
    expect(mergeStoredModelProfiles({ modelProfiles: allLanesOff }, {}).modelProfiles).toEqual(
      allLanesOff,
    );
  });

  it("lets a named lane win over the stored entry", () => {
    expect(
      mergeStoredModelProfiles(
        { modelProfiles: allLanesOff },
        { modelProfiles: { senior: { enabled: true, adapterConfig: { model: "b" } } } },
      ).modelProfiles,
    ).toEqual({
      cheap: { enabled: false },
      senior: { enabled: true, adapterConfig: { model: "b" } },
      mid: { enabled: false },
      junior: { enabled: false },
    });
  });

  it("does not seed lanes neither side carries, so an already-deployed agent is not silently re-defaulted", () => {
    expect(mergeStoredModelProfiles({}, { heartbeat: { enabled: true } })).toEqual({
      heartbeat: { enabled: true },
    });
    expect(changedWorkModelProfileKeys({}, mergeStoredModelProfiles({}, {}))).toEqual([]);
  });
});
