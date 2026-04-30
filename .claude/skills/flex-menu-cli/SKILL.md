---
name: flex-menu-cli
description: Use when working in this repository to inspect a logged-in flex.team workspace, map sidebar menus to flex-cli command groups, and implement new live flex-cli subcommands without assuming crawled data or a local SQLite DB. Trigger for requests like exploring flex.team menus, turning a menu into a command, or adding attendance/document/people style live commands.
---

# flex-menu-cli

Use this skill when the job is:

- inspect the current `flex.team` UI from an already logged-in browser
- decide which left-sidebar menu should become a `flex-ax` command group
- add a new live command under `apps/flex-cli` that calls flex APIs directly
- do this **without** assuming `crawl`, `import`, exported JSON, or `flex-ax.db`

This skill is for command discovery and command scaffolding. If the task is to
capture an unknown write flow or payload sequence, use `flex-explore` instead.

## Read First

Before browser work, read the full `playwriter` docs:

```bash
playwriter skill
```

Do not skip this. This repository should use `playwriter`, not `playwright-cli`,
for logged-in `flex.team` inspection.

## Repo Entry Points

Read these files first:

- `apps/flex-cli/src/cli.ts`
- `apps/flex-cli/src/cli-help.ts`
- `apps/flex-cli/src/commands/workflow.ts`
- `apps/flex-cli/src/auth/index.ts`
- `apps/flex-cli/src/crawlers/shared.ts`

Then read only the domain files relevant to the menu you are mapping. See
`references/domain-map.md`.

## Standard Procedure

### 1) Confirm browser access

- Assume the user already has a logged-in `flex.team` tab.
- Attach with `playwriter`.
- If the relay fails or the wrong tab is attached, ask the user to click the
  Playwriter extension icon on the target `flex.team` tab.

### 2) Inspect sidebar menus

- Start from the current `flex.team` tab.
- Capture the visible left-sidebar menu labels and the URL each menu opens.
- Prefer top-level menu groups first:
  - `홈 피드`
  - `구성원`
  - `근무`
  - `휴가`
  - `워크플로우`
  - `문서·증명서`
- Use browser observation only to identify the product surface and menu shape.
- Do not overfit to unstable DOM details. Once the product area is identified,
  switch to codebase and API inspection.

### 3) Choose command candidates

Prefer menu groups that already have a clear API/domain boundary in the repo:

- `workflow`
- `attendance` / `time-off`
- `document`
- `people`

Avoid starting with UI-heavy groups unless explicitly requested:

- `home`
- feed-like dashboards
- announcement widgets

### 4) Default implementation strategy

Assume:

- no crawled JSON
- no imported SQLite DB
- no `OUTPUT_DIR` setup

So the command should be a **live API command**.

Reuse this auth flow:

1. `authenticate(config, logger)`
2. `listCorporations(authCtx, baseUrl)`
3. `switchCustomer(authCtx, baseUrl, customerIdHash, userIdHash)`
4. `flexFetch` / `flexPost`

Do not introduce a separate login path unless the existing auth stack cannot
support the target API.

### 5) Match the existing command style

Use `workflow` as the pattern:

- one top-level dispatcher in `apps/flex-cli/src/commands/<domain>.ts`
- a small set of explicit subcommands
- concise `printUsage()`
- shared `--customer` handling
- stdout for command results
- logger/stderr for operational messages

Good initial shapes:

- `attendance list|show`
- `document list|show|attachments`
- `people list|show`

Start read-only. Do not implement mutating actions first unless the user asked
for them and the API is already understood.

### 6) Wire it into the CLI

Update:

- `apps/flex-cli/src/cli.ts`
- `apps/flex-cli/src/cli-help.ts`

If multiple new domains need the same auth setup, factor out a small shared
helper under `apps/flex-cli/src/commands/`.

### 7) Validate

Run:

```bash
pnpm --dir apps/flex-cli lint
pnpm --dir apps/flex-cli build
```

If `pnpm --dir apps/flex-cli start -- ...` fails in sandbox due to `tsx` IPC
permissions, validate with the built CLI instead:

```bash
node apps/flex-cli/dist/cli.js <command> --help
```

## Decision Rules

- If the repo already has crawler/domain code for the menu area, reuse its API
  knowledge but do not require stored crawl output.
- If the menu area is only discoverable through the live UI, inspect with
  `playwriter` first and then codify the result in CLI commands.
- If a flow requires unknown write payloads, stop and switch to `flex-explore`.
- If a menu maps poorly to CLI because it is mostly dashboard UI, say so and
  choose a narrower domain.

## Expected Output

For this skill, the normal end state is:

- a new or updated command file in `apps/flex-cli/src/commands/`
- updated CLI dispatch/help wiring
- buildable TypeScript
- a short note explaining which `flex.team` menu the command corresponds to

## References

- Repo architecture and implementation checklist: `references/architecture.md`
- Menu-to-domain mapping: `references/domain-map.md`
