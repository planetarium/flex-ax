# Domain Map

Use this file to choose which product area should become a CLI command first.

## Known top-level flex.team menus

- `홈 피드`
- `구성원`
- `근무`
- `휴가`
- `워크플로우`
- `문서·증명서`

Observed product URLs during exploration included:

- `/home`
- `/people`
- `/time-tracking/my-work-record`
- `/time-tracking/my-time-off/dashboard`
- `/workflow/archive/my`
- `/document/company`

## Recommended command mapping

### workflow

Use when:

- the menu is clearly approval-document oriented
- template discovery, draft creation, or submit already exists

Repo anchors:

- `apps/flex-cli/src/commands/workflow.ts`
- `apps/flex-cli/src/workflow/*`

### attendance / time-off

Use when:

- the menu is `근무` or `휴가`
- the goal is listing personal attendance or time-off data

Repo anchors:

- `apps/flex-cli/src/crawlers/attendance.ts`
- `apps/flex-cli/src/types/attendance.ts`

Notes:

- start with `attendance list|show`
- prefer read-only live endpoints first

### document

Use when:

- the menu is `문서·증명서`
- the goal is listing or inspecting approval documents or attachment metadata

Repo anchors:

- `apps/flex-cli/src/crawlers/instance.ts`
- `apps/flex-cli/src/types/instance.ts`

Notes:

- start with `document list|show|attachments`
- use approval-document APIs before considering export/import flows

### people

Use when:

- the menu is `구성원`
- the goal is directory-like lookup or profile inspection

Repo anchors:

- employee/personnel tables in `apps/flex-cli/src/db/schema.sql`
- auth and shared fetch helpers

Notes:

- only add this when the actual API surface is clear
- likely shape: `people list|show`

### home

Avoid as a first CLI domain.

Reason:

- this area is dashboard-heavy and UI-centric
- feed widgets do not map cleanly to stable CLI commands

Only automate it if the user asks for a specific narrow function.
