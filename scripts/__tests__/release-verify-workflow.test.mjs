import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

test("release workflow keeps canary and stable verification wiring to the reusable workflow (disabled on this fork)", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // Fork context (#4, commit a59ef884): release automation is intentionally
  // disabled here — this fork stages upstream fixes and ships GHCR images, it
  // does not npm-publish. Every release job is gated `if: false` (see the
  // comment block atop release.yml and doc/RELEASE-AUTOMATION-SETUP.md). This
  // test asserts the disabled-but-preserved wiring: the jobs stay off
  // (`if: false`) while the delegation to release-verify.yml and its `ref`
  // inputs remain intact, so re-enabling is a one-line `if:` flip. If this fork
  // starts publishing, flip the `if:` here and in release.yml together.
  assert.match(
    releaseWorkflow,
    /verify_canary:\n\s+if: false\n\s+uses: \.\/\.github\/workflows\/release-verify\.yml\n\s+with:\n\s+ref: \$\{\{ github\.sha \}\}/,
  );
  assert.match(
    releaseWorkflow,
    /verify_stable:\n\s+if: false\n\s+uses: \.\/\.github\/workflows\/release-verify\.yml\n\s+with:\n\s+ref: \$\{\{ inputs\.source_ref \}\}/,
  );
  assert.doesNotMatch(releaseWorkflow, /verify_(?:canary|stable):[\s\S]*?pnpm test:run(?:\n|$)/);
});

test("release verify workflow covers the same split test surface as stable PR verification", () => {
  const verifyWorkflow = readWorkflow("release-verify.yml");

  assert.match(verifyWorkflow, /workflow_call:/);
  assert.match(verifyWorkflow, /node \.\/scripts\/release-package-map\.mjs check/);
  assert.match(verifyWorkflow, /pnpm -r typecheck/);
  assert.match(verifyWorkflow, /pnpm build/);

  for (const group of ["general-server", "general-workspaces-a", "general-workspaces-b"]) {
    assert.match(verifyWorkflow, new RegExp(`group: ${group}`));
  }

  for (const shardIndex of [0, 1, 2]) {
    assert.match(
      verifyWorkflow,
      new RegExp(`group: general-server[\\s\\S]*?shard_index: ${shardIndex}[\\s\\S]*?shard_count: 3`),
    );
  }

  for (const shardIndex of [0, 1, 2, 3]) {
    assert.match(verifyWorkflow, new RegExp(`shard_index: ${shardIndex}[\\s\\S]*?shard_count: 4`));
  }

  assert.match(verifyWorkflow, /pnpm test:run:general -- --group/);
  assert.match(verifyWorkflow, /pnpm test:run:serialized -- --shard-index/);
});
