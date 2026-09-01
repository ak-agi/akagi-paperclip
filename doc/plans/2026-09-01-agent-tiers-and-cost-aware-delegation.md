# 2026-09-01 Agent Tiers and Cost-Aware Delegation

Status: Proposed
Date: 2026-09-01
Audience: Product and engineering
Related:
- `doc/plans/2026-04-06-smart-model-routing.md` (intra-run routing; this plan is the org-level layer)
- `doc/SPEC-implementation.md` §11.5
- `doc/execution-semantics.md` §9.3
- `doc/PRODUCT.md`, `ROADMAP.md`

## 1. Purpose

Paperclip models an agent company with an org chart, but every agent in that
org is equally expensive. A real company staffs a task at the cheapest level
that can do it well: a CTO scopes and delegates, a lead decomposes, a junior
executes narrow well-specified work, and anything ambiguous escalates back up.

This plan introduces **agent tier** as a first-class attribute and binds it to
a **model lane ladder**, so that "not every agent needs to be as smart and
costly" becomes true by construction — with no routing service, no classifier,
and no training data.

Explicit non-goal: a global cross-provider router. See §3.

## 2. Current State (verified 2026-09-01, commit f3eeac70e)

| Fact | Location |
|---|---|
| `AGENT_ROLES` is pure function (`ceo, cto, engineer, …`) — no seniority dimension | `packages/shared/src/constants.ts:47` |
| No `tier` / `level` / `seniority` field on agents | `packages/db/src/schema/agents.ts` |
| Exactly one model profile lane exists | `packages/shared/src/constants.ts:94` — `MODEL_PROFILE_KEYS = ["cheap"]` |
| Adapter-side lane key is a single literal | `packages/adapter-utils/src/types.ts:232` — `AdapterModelProfileKey = "cheap"` |
| Lane resolution already has requested/applied/fallback plumbing | `server/src/services/heartbeat.ts:3849` `resolveModelProfileApplication()` |
| Per-task lane override already persisted | `issues.assignee_adapter_overrides` jsonb |
| Team install gives **every** agent the same adapter | `server/src/services/teams-catalog.ts:700` `withSafeCatalogAdapterDefaults()` |
| Delegation rules are hardcoded prose naming specific agents | `server/src/onboarding-assets/ceo/AGENTS.md:13` |
| Cost ledger has provider/model/tokens/cents per run | `packages/db/src/schema/cost_events.ts` |
| No model price table; cost is adapter-reported, else `unpriced` | `COST_STATUSES` in `constants.ts` |

The plumbing is in place. What is missing is the concept.

## 3. Design Principles

1. **Defaults, not intelligence.** A new company has zero cost history. Anything
   learned is worst exactly when a user first evaluates the product. Ship a
   sensible default ladder that works on install.
2. **Evolution by derivation, not learning.** "Evolves with the org" is achieved
   by deriving behavior from `reportsTo` and `tier` at run time. Reorganize the
   company and the next heartbeat sees it. Deterministic, explainable, auditable
   — which matters because legibility is Paperclip's value proposition.
3. **The ladder only ever goes down from primary.** Tier can make an agent
   cheaper than its configured model. It can never silently make it more
   expensive. This makes the feature backward compatible by construction.
4. **Delegation is not free.** Every hop is a full heartbeat run. See §9.

## 4. Tier Taxonomy

```ts
export const AGENT_TIERS = ["principal", "senior", "mid", "junior"] as const;
export type AgentTier = (typeof AGENT_TIERS)[number];
```

Ordered most→least capable; rank 0..3. Orthogonal to `role` — "senior engineer"
and "junior engineer" are both `role: engineer`, differing only in `tier`.

`agents.tier` is **nullable**. `null` means "no tier declared" and behaves
exactly as today (primary model). Existing agents are unaffected by the
migration.

Tier is **stored, not derived from org depth.** Depth is not seniority: a
principal engineer reporting directly to the CTO sits shallower than a junior PM
three levels down. Deriving it would also mean a reorg silently changes
everyone's model.

## 5. Lane Ladder

```ts
export const MODEL_PROFILE_KEYS = ["cheap", "senior", "mid", "junior"] as const;
```

`cheap` keeps its current meaning **unchanged** and stays reserved for
status-only recovery coordination per `execution-semantics.md` §9.3. It is not
reachable from tier. The three new lanes are **work lanes** and do permit
deliverable work.

Tier → lane mapping:

| Tier | Lane | Effect |
|---|---|---|
| `principal` | *(none)* | agent's configured primary model — today's behavior |
| `senior` | `senior` | |
| `mid` | `mid` | |
| `junior` | `junior` | |
| `null` | *(none)* | primary model — today's behavior |

Naming the lanes after the tiers is deliberate: one concept, legible in both the
UI and agent-facing context ("you are junior tier, you run the junior lane").

Adapters declare which lanes they support via the existing `modelProfiles`
registry field. Unsupported lanes already degrade through the
`adapter_profile_not_supported` fallback path — no new failure mode.

Suggested starting configs for `claude_local` (adapter owner's call; tune with
real data from §8):

| Lane | model | effort |
|---|---|---|
| `senior` | opus-class | medium |
| `mid` | sonnet-class | medium |
| `junior` | haiku-class | low |

`codex_local` and `opencode_local` follow the same shape with their own
adapter-specific effort keys (`modelReasoningEffort`, `variant`).

## 6. Resolution Precedence

`resolveModelProfileApplication()` gains a third, lowest-priority request source:

1. `issue.assigneeAdapterOverrides.modelProfile` — explicit per-task choice
   (`requestedBy: "issue_override"`)
2. wake context `modelProfile` — recovery lane (`requestedBy: "wake_context"`)
3. **agent tier default lane** — new (`requestedBy: "agent_tier"`)

An explicit override always wins over tier. Recovery always wins over tier. This
keeps every existing behavior intact and makes tier a pure default.

Run metadata already records `requested / requestedBy / applied / configSource /
fallbackReason`; `agent_tier` flows through it unchanged and renders in the
existing `IssueRunLedger` badges.

## 7. Derived Delegation Context

Replace the hardcoded routing prose at `onboarding-assets/ceo/AGENTS.md:13`
("Code, bugs, infra → CTO; Marketing → CMO; UX → UXDesigner") with a block
generated from live data:

- the agent's actual direct reports, with role, tier, and budget headroom
- the **delegate-vs-do rule**: delegate when the task is well-specified and
  expected to be long relative to the cost of specifying it; do it yourself when
  specifying costs as much as doing
- the **escalate-on-ambiguity rule** (§8)

Generated from `reportsTo`, so it works for any company and updates the moment
the org changes. No per-company markdown.

## 8. Escalation Contract

Delegation down requires escalation up, or cheap tiers are reckless rather than
efficient.

A tier-limited agent that cannot proceed sets the issue `blocked` with
`unblockDescriptor.owner = { agentId: <its reportsTo> }`.

**Critical constraint:** the escalation must **not** forward the failed
reasoning chain to the higher tier. Re-spec from the original task.

Cascade research in 2026 measured accuracy drops of up to ~34.8 points when a
failed context is forwarded to a stronger model rather than calling it clean.
Paperclip's spec already encodes the correct rule for the recovery lane —
`execution-semantics.md` §9.3, "cheap recovery hints must be scrubbed from
copied retry, resume, child, and downstream source-work contexts." **Tier
escalation inherits that same scrubbing rule** rather than inventing a new one.

## 9. The Overhead Guardrail

The org analogy hides an inversion. In a human org a VP spends 5 minutes to save
3 days. In an agent org, understanding a task well enough to delegate it is
often 60–80% of the cost of doing it, and each hop is a full heartbeat run
carrying workspace context, skills, and thread history.

This is the documented failure mode of the nearest shipping analogue: CrewAI's
hierarchical process reportedly adds 30–50% token overhead for a 5-task crew
versus sequential, with practitioner reports of delegation cycles doubling or
tripling cost.

Therefore the measurement in §10 is **not optional**, and the invariant is:

> An issue tree whose orchestration cost exceeds its execution cost is a bug.

## 10. Measurement

Read model over existing data — no new writes required:

- **execution run**: a run on an issue that produced a work product, document
  revision, or file change
- **orchestration run**: a run that only created child issues, commented, or
  reassigned
- per root issue: `orchestration_cents / total_cents`
- secondary: cost per tier, tier success rate (completed without recovery or
  reopen), delegation depth distribution via `issues.requestDepth`

Surfaced as a **Routing tab** in `ui/src/pages/Costs.tsx`, alongside the existing
Overview / Budgets / Providers / Billers / Finance tabs.

Caveat to encode: exclude `costStatus: "unpriced"` rows from cost comparisons.
Subscription-billed agents (`billingType: subscription_included`) report ~zero
marginal cost and would otherwise look infinitely cheap; for those the scarce
resource is quota, not dollars.

## 11. Prior Art

- **Claude Code subagents** — per-subagent `model:` field (`sonnet|opus|haiku|
  inherit`). The closest existing analogue to §5, and evidence that a purely
  declarative binding captures most of the value. Lacks org position and cost
  feedback.
- **Anthropic Research** — Opus lead + 3–5 Sonnet subagents; a two-tier org that
  beat single-agent Opus by 90.2% at ~15x tokens. Note it is a *quality* play
  that costs more; using the structure as a *cost* play is the less-trodden
  direction.
- **CrewAI hierarchical process** — `manager_llm` distinct from worker LLMs. The
  source of the overhead figures in §9.
- **RouteLLM / NotDiamond / Martian / OpenRouter Auto** — request-level,
  stateless, org-blind. They structurally cannot see that a task is junior work
  because its parent was scoped by a lead. That gap is this plan's differentiator.
- **FrugalGPT-style cascades** — the escalation half of §8, plus the
  failed-context finding.
- Contrarian: *"Drop the Hierarchy and Roles: How Self-Organizing LLM Agents
  Outperform Designed Structures"* (arXiv 2603.28990) argues designed hierarchies
  underperform. Worth reading before committing to §7.

## 12. Work Breakdown

Wave 1 — independent, parallelizable:

| PR | Scope | Behavior change |
|---|---|---|
| **PR-1** | Tier primitive: schema, migration, constants, types, validators, agent service, portability, config UI | none (metadata only) |
| **PR-2** | Lane ladder: extend `MODEL_PROFILE_KEYS` + `AdapterModelProfileKey`, adapter `modelProfiles` entries, spec amendments | none (lanes added, unused) |
| **PR-3** | Measurement: orchestration-vs-execution read model, route, Costs → Routing tab | none (read-only) |

Wave 2 — depends on Wave 1:

| PR | Scope | Depends on |
|---|---|---|
| **PR-4** | Tier→lane resolution in `resolveModelProfileApplication()` | PR-1, PR-2 |
| **PR-5** | Derived delegation context (§7) | PR-1 |
| **PR-6** | Escalation contract (§8) | PR-1 |
| **PR-7** | Team-install tier defaults — fix `withSafeCatalogAdapterDefaults()` | PR-1, PR-4 |

Wave 3 — only if §10 shows it is needed:

| PR | Scope |
|---|---|
| PR-8 | Advisory tier/assignee suggestion using accumulated data. Likely unnecessary. |

## 13. Risks

| Risk | Mitigation |
|---|---|
| Delegation overhead exceeds model savings (§9) | PR-3 ships in Wave 1 specifically to detect this; hop budget invariant |
| Junior tier attempts ambiguous work and produces rework | §8 escalation contract; tier is a default the task shape can override |
| `cheap` lane semantics get conflated with work lanes | Separate key kept reserved; spec amendment makes it explicit |
| Adapter model IDs drift | Route on adapter-declared **lanes**, never on model ID strings |
| Subscription billing makes agents look free | Exclude `unpriced`; treat quota as the scarce resource |
| Scope creep into auto-reorg (ROADMAP L101) | Tier recommends *within* the current org; it never changes the org |

## 14. Verification

Per `CLAUDE.md`, every PR must pass:

```sh
corepack pnpm -r typecheck && corepack pnpm test:run && corepack pnpm build
```

Plus per-PR: unit tests for tier rank/validation (PR-1), lane resolution and
fallback (PR-2, PR-4), read-model aggregation including the `unpriced` exclusion
(PR-3), and UI tests for config save/load.

## 15. Recommendation

Ship PR-1, PR-2 and PR-3 first. Together they add the primitive, the ladder, and
the instrument — with zero behavior change. PR-4 is the switch that turns the
feature on, and by then §10 can tell you whether it paid.

---

# Wave 1 Outcome and Wave 2 Handoff

Added 2026-09-02, after Wave 1 shipped. Read this section before starting Wave 2;
several decisions below change what PR-4 has to do.

## 16. What Shipped

| PR | Commit | Scope |
|---|---|---|
| #10 | `f7784eab3` | This plan |
| #14 | `40cfc2b94` | CI fix (see §20) |
| #13 | `34bda44a3` | PR-1 — tier primitive |
| #12 | `dfdf9160c` | PR-3 — orchestration cost measurement |
| #11 | `da159fc57` | PR-2 — model lane ladder |

All three carry **zero behavior change**. Nothing selects a lane by tier yet.
That is PR-4, and it is the switch that turns the feature on.

## 17. Decisions Made During Implementation

These differ from, or add to, §4–§6 above.

**Tier taxonomy shipped as planned.** `AGENT_TIERS = ["principal", "senior", "mid",
"junior"]` with `AGENT_TIER_LABELS`, `AGENT_TIER_RANKS` (0..3) and `isAgentTier()`
in `packages/shared/src/constants.ts`. `agents.tier` is nullable (migration `0234`),
no default, no backfill.

**`Agent.tier` is optional on the type** (`tier?: AgentTier | null`), not required,
so external plugins constructing `Agent` literals through `@paperclipai/plugins-sdk`
still typecheck.

**Lane ladder shipped as planned.** `MODEL_PROFILE_KEYS = ["cheap", "senior", "mid",
"junior"]`, plus `WORK_MODEL_PROFILE_KEYS = ["senior", "mid", "junior"]` and
`isWorkModelProfileKey()` to separate work lanes from the reserved recovery lane.
`AdapterModelProfileKey` now derives from the shared constant rather than
duplicating the literals.

**The §9.3 recovery guard no longer keys off the lane.** This is the most important
change for PR-4. `isStatusOnlyRecoveryGuardContext()` in
`server/src/services/recovery/model-profile-hint.ts` tests `recoveryIntent` plus the
three guard flags — never `context.modelProfile`. It replaced two duplicated
predicates in `routes/issues.ts` and `routes/approvals.ts`.

Why: `resolveModelProfileApplication()` gives the issue override priority over the
wake context, and dispatch writes the winner back into the run's persisted
`contextSnapshot`. While `"cheap"` was the only possible value that write was a
no-op for recovery runs. Once work lanes existed, an issue carrying
`modelProfile: "senior"` turned every subsequent status-only recovery wake for that
issue into an unguarded Opus-class run that still advertised
`allowDeliverableWork: false`.

**A status-only recovery context now wins over the per-issue override** in
`resolveModelProfileApplication()`. Precedence is unchanged for every other case: an
ordinary wake-context lane still loses to an issue override.

**`assertCheapRecoveryIssueAssigneeProfileAllowed` now rejects any lane**, not only
`"cheap"`. Pre-widening those were the same check.

**The agent profile consent gate now gates on intersection.**
`server/src/routes/agents.ts` previously required *every* key in a PATCH to be a
consent field, so `PATCH {"tier":"principal","icon":"bot"}` from an agent's own key
bypassed it entirely. A mixed patch now clears both `assertCanUpdateAgent` and
`assertCanApplyAgentProfileChange`. The ordinary check runs first on purpose: the
consent check *consumes* the stored confirmation record, so a request that will be
denied must not burn it. This also closed the same hole for `name`, `role`, `title`
and `capabilities`, which was pre-existing on master.

## 18. Known Gaps PR-4 Must Close

**Work lanes are enabled by default with no operator kill switch.** New agents are
seeded `modelProfiles.cheap = { enabled: false }` (`routes/agents.ts`), but nothing
equivalent for work lanes, and an absent runtime entry means enabled. The agent
config UI can only write `runtimeConfig.modelProfiles.cheap` —
`ui/src/lib/agent-config-patch.ts` types the overlay as `{ cheap?: … }`. So the
*request* path is live for agents and the wake API today while the *disable* path is
not. Any agent that can create or update an issue can pin work to `senior`, the
priciest lane, with no approval gate.

**Create-time tier is not consent-gated.** The gate is PATCH-only.
`createAgentSchema` accepts `tier`, and both create routes spread it into
`svc.create`, so an agent principal with `agents:create` can spawn an agent at
`tier: "principal"` with no consent record. The company importer does the same on
its create path and is reachable by a same-company CEO agent. Agent-safe imports
cannot re-tier an *existing* agent, so this is "spawn high-tier", not "re-tier a
peer". It is not tier-specific — `name`, `role`, `title` and `capabilities` share
the path — and the consent gate keys on the target agent's id
(`agent:<id>:profile`), which does not exist pre-create, so closing it needs a new
target-key concept.

Both gaps are benign while tier is metadata-only. **Both become real the moment PR-4
binds tier to a lane.**

## 19. The Measurement Surface (from PR-3)

Use this to judge whether PR-4 paid. Do not re-derive it.

- `GET /api/companies/{companyId}/costs/routing`, Costs → Routing tab
- Service: `server/src/services/orchestration-costs.ts`
- `overheadVerdict: "inverted" | "balanced" | "in_flight" | "below_floor" |
  "indeterminate"` — replaced a boolean so `false` cannot be read as "healthy"
- `basis: "cents" | "tokens" | "indeterminate"` on every grain. Cents are only an
  honest basis when no row was held out; `unpriced` and `subscription_included` rows
  are both excluded from cent sums, so a tree mixing metered and subscription spend
  reports `indeterminate` rather than a false verdict
- An `exclusions` block (`no_issue`, `no_run`, `unresolved_issue`, `hidden_tree`)
  accounts for every dropped cost event, so the Routing total always reconciles with
  the Overview total
- Indexes in migration `0235`, with `migration-safety-ignore` annotations because
  drizzle applies migrations transactionally and cannot use `CONCURRENTLY`

Known bias, deliberately not fixed: run classification is winner-take-all with
execution precedence, and the execution probes are company-scoped rather than
tree-scoped. Both **under-report** orchestration, so the instrument errs toward "no
problem here". Revisit before the numbers gate anything.

## 20. Environment and Process Notes

- `pnpm` is not on PATH. Use `corepack pnpm`. Some nested scripts call bare `pnpm`;
  a shim on PATH fixes those.
- Rust is installed but not on PATH in non-login shells:
  `export PATH="$HOME/.cargo/bin:$PATH"`. A failure in `packages/paperclip-runner`
  is a PATH problem, not a missing toolchain.
- Do not run the full `pnpm test:run` concurrently in several worktrees.
  `workspace-runtime-exposure*` binds a fixed port range `[42000, 42999]` and the
  runs collide. Use targeted runs while iterating and let CI do the full pass.
- Known flaky, unrelated to this work: `adapter-utils`
  `execution-target-stdin-race.test.ts` T22/T24 (load-induced; passes in isolation
  on master) and the Rust `codex_provider`
  `ambiguous_replacement_turn_adopts_one_later_completion_identity`.
- CI was previously red on every pull request. `policy` failed on
  `release-verify-workflow.test.mjs`, and `verify` and `e2e` both assert
  `POLICY_RESULT = success` before anything else, so every downstream job showed
  `skipping` and no pull request received real verification. Fixed in #14. If those
  three go red together again, check `policy` first.

## 21. The Bug Pattern Worth Watching

Three separate defects in Wave 1 were the same shape: **a check written when a set
had one member, silently weakened when the set grew.**

- `isStatusOnlyCheapRecoveryContext` compared `modelProfile === "cheap"`
- `assertCheapRecoveryIssueAssigneeProfileAllowed` rejected only `"cheap"` downstream
- `profileOnlyChange` used `.every()`, safe only while nobody added a second key

Each was correct when written and became incorrect through a change elsewhere, with
no test failing. In all three cases the authoring agent asserted a test covered it
and the test did not exercise the case. When PR-4 widens behavior again, write the
test that fails against the *old* code first.
