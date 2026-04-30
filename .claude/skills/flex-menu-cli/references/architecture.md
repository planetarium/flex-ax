# Architecture

## Read Order

1. `apps/flex-cli/src/cli.ts`
2. `apps/flex-cli/src/cli-help.ts`
3. `apps/flex-cli/src/commands/workflow.ts`
4. `apps/flex-cli/src/auth/index.ts`
5. `apps/flex-cli/src/crawlers/shared.ts`

This gives the standard command shape, help conventions, auth flow, and HTTP
helpers before you read any domain-specific code.

## Existing Patterns

### CLI dispatcher

- `cli.ts` owns top-level command dispatch.
- New command groups should be added as new `case` branches with lazy imports.

### Help text

- `cli-help.ts` has:
  - top-level command summaries
  - per-command help text
- Keep new entries short and action-oriented.

### Workflow pattern

`commands/workflow.ts` is the reference pattern for grouped commands:

- `runWorkflow()` dispatches subcommands
- `printUsage()` documents them
- common options are parsed once
- auth and customer selection are shared
- operational logs go to stderr via logger
- actual command output goes to stdout

### Auth pattern

Use these from `auth/index.ts`:

- `authenticate`
- `listCorporations`
- `switchCustomer`
- `cleanup`
- `apiHeaders`

For live commands, the normal path is:

1. load config
2. authenticate
3. enumerate corporations
4. choose one corporation
5. switch customer
6. call product APIs with `flexFetch` / `flexPost`

### Validation

Use:

```bash
pnpm --dir apps/flex-cli lint
pnpm --dir apps/flex-cli build
```

If sandboxed `tsx` runtime is blocked, validate built output with:

```bash
node apps/flex-cli/dist/cli.js <command> --help
```

## Implementation Checklist

- Add `apps/flex-cli/src/commands/<domain>.ts`
- Reuse auth flow; do not add a parallel login stack
- Keep the first version read-only if possible
- Add top-level dispatch in `cli.ts`
- Add help entries in `cli-help.ts`
- Build and lint
