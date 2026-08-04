# Sequence Run Channel Cards Design

**Status:** Approved in conversation on 2026-08-04.

## Goal

Present multi-channel sequence execution as one persistent card per channel. Cards exist before a run, show only the channel's current execution state, and open a dedicated channel detail screen containing the complete step history and timing.

## Channel overview

The sequence run page renders one card for every enabled or selected channel as soon as the page opens. Card order is stable by channel index and never changes during a run. When the Center has no channel configuration, a synthetic CH0 card is shown.

Each card contains:

- channel name and overall state;
- current step number and name, or `等待运行` before execution;
- live current-step elapsed time;
- live/final channel elapsed time;
- completed/total progress and a progress bar;
- pass, fail, and skipped counts;
- a `查看详情` affordance, while the complete card remains clickable.

Initial cards show `待开始`, `0 / N`, zero counts, and no current step. Running cards emphasize the current step. Completed cards summarize pass/fail counts. Failed and aborted cards preserve the failing/last step name. Cards are never used as individual step tiles.

The top control area retains queue summary, channel selection, overall state, Start, Abort, and the link back to sequence editing. The existing channel matrix, operator/engineer view switch, exception filter, bottom inspector, and full matrix report are removed.

## Channel detail screen

Selecting a card opens a channel-specific detail screen inside the existing single-page application. The detail screen exists and is usable before execution.

Its header contains Back to overview, channel name, overall state, channel elapsed time, pass/fail/skipped/total counts, and previous/next channel navigation. A current-step panel shows the active step, live step time, and channel progress.

All queue steps are present in original order from the start. Each row shows step number, name, status, elapsed time, measured summary, and Spec summary. Pending rows show `—` elapsed time. Completed, failed, errored, skipped, and aborted rows keep their final status and elapsed time. The active row is highlighted and kept visible without reordering rows.

Selecting a row expands its measured values/limits, configured inputs, complete output, error, raw JSON, and log location. The detail screen updates from the same 250 ms progress poll and does not start a second request.

## Timing contract

Timing is recorded by the Agent, not estimated from poll arrival times.

- `SequenceStepResult.elapsed_ms` records time from making an enabled step current through resource waiting and execution until its terminal result. Skipped steps record `0`.
- `SequenceResponse.elapsed_ms` records the channel worker's total sequence time.
- `ChannelProgressSnapshot.elapsed_ms` exposes live/final channel time.
- `ChannelProgressSnapshot.current_step_elapsed_ms` exposes live current-step time and is absent when no step is active.
- Sequence-run logs include channel and per-step `elapsed_ms` values.

All fields are additive and use serde defaults where deserialization compatibility is required.

## Responsive behavior

The overview uses an auto-fit grid with a minimum card width near 19rem. At desktop widths it shows multiple equal-height cards; at narrow widths it becomes one column. The detail screen uses a compact step table on desktop and horizontal table scrolling on narrow screens. No fixed footer overlays content.

## Verification

- Rust unit tests verify enabled success/error steps receive elapsed time, skipped steps record zero, and progress snapshots expose live/final timing.
- JavaScript behavior tests verify pending cards are derived before execution, card summaries follow current/final state, card selection opens the requested channel, and elapsed formatting is stable.
- Static UI tests verify the overview/detail hosts exist and the old matrix/operator/engineer/inspector structure is absent.
- Full Node and Rust workspace test suites remain green.

## Non-goals

- No database persistence for run history.
- No changes to sequence request payloads, cancellation, resource locking, templates, or the sequence editor.
- No cross-channel matrix or engineer comparison mode.
