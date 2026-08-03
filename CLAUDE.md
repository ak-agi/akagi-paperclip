# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is Paperclip

Paperclip is a control plane for AI-agent companies. It orchestrates teams of AI agents (Claude, Codex, Cursor, OpenClaw, etc.) with org charts, goal alignment, budgets, approval gates, and task management. The current build target is V1, defined in `doc/SPEC-implementation.md`.

Before making changes, read in this order: `doc/GOAL.md` → `doc/PRODUCT.md` → `doc/SPEC-implementation.md` → `doc/DEVELOPING.md` → `doc/DATABASE.md`.

## Commands

```sh
pnpm install       # Install all workspace dependencies
pnpm dev           # Start API + UI dev server at http://localhost:3100
pnpm dev:server    # API only
pnpm dev:ui        # UI only
```

```sh
pnpm -r typecheck  # Type-check all packages
pnpm test:run      # Run all Vitest tests (single run)
pnpm test          # Tests in watch mode
pnpm build         # Build all packages
```

```sh
pnpm test:e2e          # Playwright e2e tests (headless)
pnpm test:e2e:headed   # E2E tests with browser visible
```

**Before handing off any change, run:**
```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

### Database Changes

```sh
# 1. Edit packages/db/src/schema/*.ts
# 2. Export new tables from packages/db/src/schema/index.ts
pnpm db:generate   # Compile schema + generate migration
pnpm db:migrate    # Apply pending migrations
```

Reset local dev DB:
```sh
rm -rf data/pglite && pnpm dev
```

### Fork-Specific Notes (this fork)

- Runs on port **3101+** (auto-detects if 3100 is taken by upstream)
- `npx vite build` hangs on NTFS — use `node node_modules/vite/bin/vite.js build` instead
- Server startup from NTFS takes 30–60s — don't assume failure immediately
- Before starting, kill existing processes: `pkill -f "paperclip"; pkill -f "tsx.*index.ts"`
- Vite cache survives `rm -rf dist` — delete both: `rm -rf ui/dist ui/node_modules/.vite`

## Architecture

### Monorepo Layout

| Path | Purpose |
|------|---------|
| `server/` | Express REST API (`/api/*`) + orchestration services |
| `ui/` | React 19 + Vite board dashboard SPA |
| `packages/db/` | Drizzle ORM schema, migrations, DB clients (PostgreSQL / embedded PGlite in dev) |
| `packages/shared/` | Shared types, constants, validators, API path constants |
| `packages/adapters/` | Agent adapter implementations (Claude, Codex, Cursor, OpenClaw, etc.) |
| `packages/adapter-utils/` | Shared adapter utilities |
| `packages/plugins/` | Plugin system packages |
| `packages/mcp-server/` | Model Context Protocol server |
| `cli/` | `paperclipai` CLI binary |
| `doc/` | Operational and product documentation |
| `tests/e2e/` | Playwright end-to-end tests |

### Stack

- **Backend**: Express.js, Drizzle ORM, PostgreSQL (embedded PGlite in dev), better-auth, pino
- **Frontend**: React 19, React Router v7, TanStack React Query v5, Radix UI, Tailwind CSS v4, Lexical
- **Tooling**: pnpm workspaces, TypeScript, Vitest, Playwright

### Key Patterns

**Company scoping** — every domain entity is scoped to a company; boundaries are enforced in every route and service.

**Contract synchronization** — when changing schema/API behavior, update all layers: `packages/db` schema → `packages/shared` types/constants/validators → `server` routes/services → `ui` API clients and pages.

**Control-plane invariants to preserve:**
- Single-assignee task model with atomic issue checkout semantics
- Budget hard-stop auto-pause behavior
- Approval gates for governed actions
- Activity log entries for all mutating actions

**API conventions:**
- Base path `/api`; consistent HTTP errors (`400/401/403/404/409/422/500`)
- Board access = full-control operator; agent access uses bearer API keys (`agent_api_keys`) hashed at rest
- Agent keys must not access other companies

**Frontend patterns:**
- React Router for routing; company selection context for company-scoped pages
- TanStack React Query for all API state
- Radix UI primitives + Tailwind for styling (see `ui/src/pages/DesignGuide.tsx` for component showcase)

### Plugin / Adapter System

Adapters can be loaded as external plugins via `~/.paperclip/adapter-plugins.json`. The plugin-loader has zero hardcoded adapter imports — pure dynamic loading. `createServerAdapter()` must include all optional fields (including `detectModel`). Built-in UI adapters can shadow external plugin parsers — remove the built-in when fully externalizing an adapter.

This fork's Hermes adapter is **external-only** (branch `feat/externalize-hermes-adapter`). Register it through Board → Adapter manager; do not add Hermes imports in `server/` or `ui/` source.

### Fork QoL Patches (not in upstream)

These UI modifications are **already applied** in this fork's source. Do **not** re-add them — they are documented here so you recognize them and can re-apply them only if source is ever re-copied wholesale from upstream:

1. **stderr_group** — amber accordion batching consecutive stderr lines (e.g. MCP init noise). Batched inline in `normalizeTranscript` and rendered by `TranscriptStderrGroup` in `ui/src/components/transcript/RunTranscriptView.tsx`.
2. **tool_group** — accordion grouping consecutive non-command tools (write, read, search, browser). See `groupToolBlocks` in the same `RunTranscriptView.tsx`.
3. **Agent Detail latest-run excerpt** — `LatestRunCard` in `ui/src/pages/AgentDetail.tsx` strips markdown and shows the first 3 lines / 280 chars of the run summary. It renders on the **Agent Detail page**, not the Dashboard.

## Pull Request Requirements

When creating a PR, read and fill in every section of `.github/PULL_REQUEST_TEMPLATE.md`. Required sections: **Thinking Path**, **What Changed**, **Verification**, **Risks**, **Model Used** (provider + exact model ID), **Checklist**.

## Definition of Done

A change is done when:
1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build all pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the template with all sections filled in

## Plan Documents

New plan documents belong in `doc/plans/` with `YYYY-MM-DD-slug.md` filenames.
