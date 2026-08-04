# Sequence Run Grouped Channel Detail Design

**Status:** Approved in conversation on 2026-08-04.

## Goal

Restore sequence group information in the per-channel run detail screen and make the relationship between groups and their steps immediately scannable without changing execution semantics or backend response formats.

## Existing data model

The persisted run queue already contains group headers with `template_source: "group"`. A group owns every following non-group row until the next group header. The header supplies:

- `name`: visible group title;
- `note`: optional description;
- `enabled`: whether the complete group is enabled;
- `collapsed`: the initial detail-view collapsed state.

Execution results contain only runnable steps. Group headers are intentionally excluded by `queue_items_for_run`, so the frontend must join results to the complete queue while preserving group headers as presentation-only nodes.

## Detail projection

Replace the flat detail projection with an ordered list of sections. Each section is either:

1. a named group and its member steps; or
2. one synthetic `未分组步骤` section containing root-level steps before the first group.

Each step keeps its original persisted `position`, because progress and final results are keyed by that position. Group headers do not consume a result row and never receive an artificial step result.

The projection exposes these group fields:

- title and note;
- enabled/disabled state;
- initial collapsed state;
- member step count;
- completed, passed, failed, and skipped counts;
- aggregate visual state: `running`, `fail`, `pass`, `skipped`, `pending`, or `disabled`.

Aggregate state is evaluated as follows: disabled groups use `disabled`; an active member makes the group `running`; any failed/error/aborted member makes it `fail`; when every member is terminal, the group is `pass` if at least one member passed and otherwise `skipped`; every other case is `pending`. Empty groups remain `pending` unless disabled.

The channel-level card totals remain step-only totals. Groups do not increase the number of executable steps.

## Visual design

Each group renders as a compact section rather than another large channel card.

The group header contains:

- a folder/section marker and group title;
- optional note on a secondary line;
- a status badge;
- `完成 / 总数` plus pass/fail/skipped counts;
- a disclosure control.

The header uses a tinted background and a strong left status rail. Group steps sit inside a lightly bordered body with a vertical hierarchy guide and a modest left indent. This produces clear ownership without stacking heavy cards inside the already card-like channel detail screen.

Status colors follow the channel detail language:

- running: orange;
- failed/error/aborted: red;
- passed: green;
- disabled/skipped: neutral gray;
- pending: quiet surface color.

The active group automatically opens while its step is running, even if its saved initial state was collapsed. A failed group also opens so the error is visible. Otherwise, the persisted `collapsed` value supplies the initial state. User changes made in the run detail remain stable across the 250 ms polling refresh.

The synthetic `未分组步骤` section is visually quieter and omits note/disabled controls. It is rendered only when root-level steps exist.

The detail header adds `N 个组 · M 个步骤`; synthetic ungrouped content is not counted as a named group.

## Interaction and accessibility

- The group header uses native `<details>/<summary>` disclosure behavior.
- The summary exposes visible text for state and counts; color is never the sole state indicator.
- Keyboard focus and the open/closed state of groups and individual step rows survive polling rerenders.
- When the active step moves into another group, that group opens and the active step scrolls into view once.
- Collapsing a group only affects presentation and never changes queue configuration or execution.

## Responsive behavior

On desktop, group title, status, progress counts, and disclosure indicator share one row. On narrow screens, metadata wraps below the title. Step rows keep the existing compact responsive grid inside the group body. Indentation is reduced on mobile to preserve useful width.

## Testing

JavaScript behavior tests will verify:

- group headers and members are projected in original order;
- root-level steps use the synthetic ungrouped section;
- group headers do not affect executable step totals;
- running/failing/pass/disabled group state precedence;
- persisted collapsed state is preserved, while running and failed groups force open;
- step result timing and status remain correctly joined by persisted position.

Static UI tests will verify the new group section styles and rendering helpers exist. Existing Node behavior tests, Rust workspace tests, JavaScript syntax checking, and `git diff --check` must remain green.

## Non-goals

- No backend schema or API changes.
- No nested groups; the current queue model supports one group-header level.
- No group-level timing field; group summaries aggregate member step results only.
- No editing, renaming, enabling, disabling, or reordering from the run detail screen.
