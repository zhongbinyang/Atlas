# Parallel Sequence Channel Runs Design

## Goal

Allow sequence channels to start and stop independently while preserving the existing step-level resource locking model. Each channel card must expose its own run and abort controls and identify the group that contains its current or last executed step.

This design supersedes the single-flight constraints in `2026-08-04-sequence-channel-card-run-design.md` for sequence channel execution only.

## Approved Behavior

- Different channels may run immediately and concurrently.
- A channel that is already running cannot be started a second time.
- `运行此通道` is disabled only for its running channel or when the queue has no runnable steps.
- `中止此通道` is enabled only while that channel is running.
- The top `中止` action aborts every running channel.
- Step resource declarations continue to provide mutual exclusion. Steps that contend for the same resource wait; unrelated steps and channels remain concurrent.
- Queue editing remains locked while any channel is running so all active runs use one stable queue definition.

## Backend Architecture

Replace the single sequence cancel/progress session with a channel run registry keyed by `channel_index`. Each entry owns:

- a monotonically increasing generation token;
- the channel identity and display name;
- a cancellation sender;
- live step, timing, and overall progress;
- the final result until a later run for the same channel replaces it.

Registry operations must be generation-scoped. Completion or cancellation from an older run must never clear or overwrite a newer run for the same channel.

Refactor the agent-wide `TaskSlot` from a single busy bit into a small admission state with two modes:

- an exclusive non-sequence owner, preserving the existing Delay/REST exclusion rules;
- one sequence holder per running `channel_index`, allowing different channels but rejecting a duplicate holder for the same channel.

Acquiring an exclusive owner fails while any sequence holder exists, and starting the first sequence channel fails while an exclusive owner exists. Adding another distinct sequence channel succeeds. This admission state prevents incompatible operation types and duplicate channel starts; it does not serialize steps or act as a test resource lock. The existing resource lock manager remains shared by all sequence workers and is the only mechanism that serializes test items across channels.

## API Behavior

### Start

`POST /api/sequence/run` keeps its current request schema and accepts one or more `channel_indexes`.

- One requested idle channel starts immediately.
- Multiple requested idle channels start concurrently.
- In a mixed request, already-running channels are reported as skipped while idle channels still start.
- If every requested channel is already running, the endpoint returns a channel-specific conflict and starts nothing.
- A response contains only the channels handled by that request. The frontend merges it with other channel state instead of replacing the complete card collection.

The fallback synthetic `CH0` continues to use the same identity for start, progress, result merge, and abort.

### Progress

`GET /api/sequence/run/progress` returns a stable snapshot of every known channel entry. Each channel reports its own `running`, `overall`, current position/name, elapsed time, current-step elapsed time, steps, and generation where needed for safe merging. The envelope-level `running` value means that at least one channel is running.

### Abort

- `POST /api/sequence/run/channels/{channel_index}/abort` signals only the matching live channel generation.
- `POST /api/sequence/run/abort` signals every live channel generation and remains the top-level “全部中止” action.
- Aborting one channel must not clear another channel's progress, result, resource wait, or cancellation signal.
- Aborting an idle or unknown channel returns a clear conflict/not-running response without affecting other channels.

## Frontend Run State

Replace the single `seqRunning` request guard as the source of card state with a per-channel running map derived from progress plus locally pending start requests. A small aggregate helper answers whether any channel is running for global controls.

- Card run buttons consult only their channel's running/pending state.
- Card abort buttons consult only their channel's running state.
- The top start action remains available when at least one selected channel is idle; running selected channels are skipped.
- The top abort action is enabled while any channel is running.
- Queue editing, template loading, and other mutations remain disabled while any channel is running.
- One shared poll loop remains active until no channel is running and no start request is pending.
- Concurrent HTTP responses and progress snapshots merge by `channel_index`; a late response for one channel cannot erase another channel's newer state.
- Focus preservation continues to restore the same channel and control after card polling rerenders. If a just-started run button becomes disabled, focus falls back to that card body or its enabled abort button.

## Channel Card Status and Group Mapping

The queue is projected once into a position-to-group lookup. A group header applies to the following steps until the next group header. Steps before the first header belong to `未分组`. Disabled groups remain identifiable in historical/final results but do not create runnable steps.

Every card uses a two-row status block:

```text
当前组    校准组
当前步骤  03 · Measure
```

Rules:

- While running or waiting for a resource, show the current step's group and step number/name.
- For an ungrouped step, show `未分组`.
- After pass, failure, abort, or stop, retain the last executed step and its group.
- Before the first run, show `当前组 —` and `当前状态 等待运行`.
- If progress temporarily points at a group header rather than a runnable step, show that group and `准备下一步骤` without treating the header as a completed step.
- Unknown backend-only historical positions use the detail view's existing result-only grouping and do not invent a named queue group on the card.

The detail view keeps its grouped sections, per-step status, measured values, and elapsed times unchanged.

## Card Actions and Accessibility

Each card action row contains two native buttons:

- primary `运行此通道`;
- destructive/secondary `中止此通道`.

Both accessible names include the channel name. Disabled state is conveyed by the native `disabled` attribute, while visible text and card status continue to prevent color-only communication. Button events remain isolated from the card-body detail action. Mobile layout may stack the two actions but must keep both fully visible and touch-friendly.

## Error Handling

- A duplicate single-channel start reports that the channel is already running.
- A channel failure updates only that channel and does not cancel siblings.
- A single-channel abort failure restores that card's abort control and shows a channel-specific message.
- A global abort reports partial failures without hiding channels that remain running.
- Network failures clear only locally pending starts whose request failed; backend-reported running channels continue polling.
- Reloading the page reconstructs live cards from the progress snapshot.
- Resource waits are displayed as live channel state, not as a global busy conflict.

## Verification

Backend tests must prove:

- different channels execute concurrently;
- duplicate starts of one channel are rejected without blocking another channel;
- same-resource steps serialize while unrelated-resource steps overlap;
- channel abort affects only its target;
- global abort signals all live channels;
- stale generations cannot clear newer progress or cancellation state;
- progress snapshots preserve simultaneous and completed channel entries.

Frontend behavior tests must prove:

- only the active card's run button is disabled;
- idle card run buttons remain actionable during another channel's run;
- card and global abort calls target the correct endpoints;
- out-of-order response merges do not erase unrelated channels;
- polling remains active until the final channel stops;
- group lookup covers named, ungrouped, disabled-group, group-header, waiting-resource, failed, and completed states;
- card rerenders preserve a useful focus target.

Static UI tests must cover the two card actions, their accessible labels/states, the two-row group/step status presentation, and responsive layout. The complete Node and Rust workspaces must remain green.

## Out of Scope

- Editing a sequence queue differently for each active channel.
- Running the same channel more than once concurrently.
- Replacing step resource locks with channel-wide locks.
- Adding per-step abort controls.
- Persisting active runs across an agent process restart.
