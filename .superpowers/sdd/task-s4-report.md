# Task 4 Report: Scheduler cutover

Status: completed.

Changes:
- Built `frontend/scheduler` with Vite and synced only scheduler dist into `crates/scheduler/static`.
- Removed legacy scheduler static files from shipped static output: `app.js`, `style.css`, `dashboard-runtime.js`.
- Rewrote `crates/scheduler/tests/static_tokens.rs` around Vite index/assets and legacy-file absence, while preserving PostgreSQL default coverage.
- Updated `README.md` so the WebUI description no longer claims shared runtime CSS tokens for scheduler and agent.
- Confirmed `crates/agent/static/app.js` still contains the vanilla agent app code.

Verification:
- Red check before sync: `cargo test -p scheduler --test static_tokens` failed on missing Vite assets, legacy `app.js`, and non-Vite index.
- Build: `npm run build` in `frontend/scheduler` passed; Vite emitted the existing large chunk warning for the scheduler JS bundle.
- Green check: `cargo test -p scheduler --test static_tokens` passed, 4 tests.
- Compile check: `cargo check -p scheduler` passed with existing dead-code warnings.
- Manual smoke: `http://127.0.0.1:26630/#/machines` returned 200 and served `/assets/index-DGoZfy-Y.js` with 200.

Concerns:
- Full browser interaction for all five routes was not performed; smoke check verified the SPA shell and Vite asset serving on port 26630.
- Scheduler bundle remains larger than Vite's default 500 kB chunk warning threshold.
