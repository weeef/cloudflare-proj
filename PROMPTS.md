# Prompt History

Every prompt sent to the AI coding assistant (Claude Code) while building this project, in order.
Each entry links to the commit(s) it produced so the git history and prompt log line up.

---

## Prompt 1: Project handoff + repo setup

> **Handoff: Cloudflare "Rack Build Readiness Agent"** (planning was done with Claude in a separate chat)
>
> **Who I am / why this exists.** I'm Jordan Bastian, applying for Cloudflare's Senior Supply Chain Program Manager – Rack Integration role (Hardware Integration Ops, Infrastructure Engineering). The application has an optional assignment: build an AI-powered app on Cloudflare and they fast-track you. My current job is program operations at Element Fleet Management supporting Amazon's Armada program across 15+ Amazon DSP sites — parts orders/requisitions, chasing unfilled orders, vendor performance reviews, Excel/Power BI reporting. The idea is an agent that automates a slice of the Cloudflare job, which is the same kind of work I already do, applied to data center hardware.
>
> **Assignment requirements** (from Cloudflare, must all be clearly present)
>
> 1. LLM — recommended Llama 3.3 on Workers AI (@cf/meta/llama-3.3-70b-instruct-fp8-fast)
> 2. Workflow / coordination — Workflows, Workers, or Durable Objects
> 3. User input via chat or voice — Pages or Realtime
> 4. Memory or state
>
> - AI-assisted coding is encouraged, but I MUST submit prompt history. Log every prompt I send in PROMPTS.md as we go (I'll paste them; remind me if I forget).
> - Docs: https://developers.cloudflare.com/agents/
>
> **The role (what the agent should mirror).** The job owns the supply-planning interface between capacity demand, L10 server/network hardware supply, and L11 full-rack integration at global integration partners. Key duties: weekly supply allocation reporting and shortage reviews, material-readiness assessments for upcoming rack builds, presenting allocation options/tradeoffs to Capacity Planning (incl. direct hardware ship vs. full rack integration), supplier business reviews (capacity, delivery, cost, quality), supply risk (bottlenecks, logistics, tariffs, regional concentration), executive reporting.
>
> **What to build**
>
> - Mock data (CSV, seeded into the agent's SQL storage):
>   - forecast: racks needed by region × week (6–8 regions like FRA, SIN, IAD, SEA, LHR, NRT; next 8 weeks)
>   - BOM: 2–3 rack types, parts + qty (servers, switches, PDUs, optics, cables…)
>   - supplier inventory + commit dates per part per supplier; a couple of suppliers unreliable so real shortages exist
> - Daily scheduled readiness check: deterministic code (NOT the LLM) compares upcoming builds vs on-hand + committed parts → flags shortages and late commits, e.g. "FRA wk3: short 40 switches, commit slips 9 days past build date". Status per build: ready / at risk / blocked.
> - Weekly shortage review as a Cloudflare Workflow: load → compute → LLM writes plain-English leadership report with 2–3 allocation options per risk + tradeoffs (delay build, ship servers direct, reallocate from lower-priority region) → draft supplier escalation emails → PAUSE for human approval → mark approved. Nothing is "sent" without approval.
> - Chat agent (Agents SDK Durable Object, Llama 3.3) with tools that query the data — e.g. "what's at risk in Europe next month", "which supplier causes the most delays", "what changed since last week's review" (uses stored past reports + chat history = memory).
> - UI: dashboard (region × week grid colored by status), latest weekly report, pending approval queue, chat panel.
> - Deploy with `npx wrangler deploy` for a live URL.
>
> **Repo / current state.** Repo: github.com/weeef/cloudflare-proj, created from the agents-starter template. Cloudflare dashboard Git-connected build failed at "Cloning repository" (fetching repository failed). Likely the repo was empty / no commits on main, or the Cloudflare GitHub app lacks repo access. Not blocking — deploying with wrangler from CLI works too. First task: check the repo state and get a clean starter committed + running.
>
> **Constraints / how I want to work**
>
> - Weekend-sized scope. Mock data, no auth.
> - Plan first: show file structure + data model before coding, let me approve.
> - Build in small steps, commit after each (git history should match the prompt log).
> - Comment the code so I can explain every part in an interview — explain choices to me as we go; I need to actually understand it.
> - If the Agents SDK works differently than described here, tell me and do it the right way.
> - README must include: what it does, mermaid architecture diagram, run/deploy steps, screenshots, "How it meets the assignment" (the 4 components with links to code), and "How this maps to the role".

**Result:** Found the GitHub repo completely empty (no branches, no commits), which is why the Cloudflare Git build failed at "Cloning repository". Committed the unmodified `cloudflare/agents-starter` template as the baseline and verified it builds. Proposed the file structure + data model for approval.

**Commits:** `chore: add cloudflare/agents-starter template as baseline`

---

## Prompt 2: Approve plan, start step 1

> Approved, go ahead with step 1 and log my reply

**Result:** Step 1 of the approved plan.

- Renamed the project and Worker to `rack-readiness-agent`.
- Moved the agent into `src/agent.ts` as `RackOpsAgent` and switched the model to `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, with a supply-chain system prompt.
- Removed the starter's demo tools (weather, timezone, calculator, scheduler) and MCP server support, from both the agent and the UI.
- Commented `wrangler.jsonc` and regenerated the `Env` types.

**Commits:** `feat: rename to rack-readiness-agent, switch to Llama 3.3, strip demo tools`

---

## Prompt 3: Fix Cloudflare Git deploy

> Before proceeding to step 2, ensure that the deployment through cloudflare is functional, I am currently attempting to manually deploy the repo, and I am getting a failed to fetch repo error. To me the repo looks in tact and in good condition to be deployed.

(Follow-up answer to a clarifying question: "Create main (Recommended)": push the current commits to a new `main` branch.)

**Result:**

- **Diagnosis:** GitHub had no `main` branch. The only branch was the AI assistant's working branch, and GitHub had made it the default because it was pushed first. Cloudflare's Git integration builds from `main` by default, so it had nothing to fetch.
- **Build check:** confirmed the build works as Cloudflare will run it. `vite build` followed by `wrangler deploy --dry-run` succeeds, with both bindings (the `RackOpsAgent` Durable Object and Workers AI) found.
- **Fix:** pushed the current history to a new `main` branch.
- **Cloudflare build settings:**
  - Build command: `npx vite build`
  - Deploy command: `npx wrangler deploy`
  - Production branch: `main`
- **Commits:** `docs: log prompt 3 (Cloudflare deploy fix)`. The same history was also pushed to `main`.

---

## Prompt 4: Step 2, mock data + seeding

> Deploy worked, go ahead with step 2

**Result:**

- **Mock data:** added `data/*.csv`: 7 regions, 8 parts, 3 rack types with their BOMs, 40 forecast builds over 8 weeks, 7 fictional suppliers and 33 supply lots.
- **Dates:** stored as day offsets from week 1. Seeding converts them to real dates, with week 1 = the coming Monday, so the demo always shows the next 8 weeks.
- **Designed problems:**
  - Nexwave Networks (68% on-time) slipped every top-of-rack switch commit, so the week 3 builds come up short.
  - Lumora Photonics (72% on-time) commits optics that land just after several build dates.
  - A few commits land inside the 7-day buffer, which makes those builds "at risk".
- **Code:** `src/db/` holds the CSV parser, the schema, the pure seed logic and the CSV imports.
- **Agent:** seeds the data on first start, inside a single transaction. Two new methods the UI can call: `getDataSummary()` and `resetDemoData()`.
- **Tests:** added Vitest. The seed tests run the real schema against in-memory SQLite (`node:sqlite`) with foreign keys enforced.

**Commits:** `feat: mock supply-chain CSVs and SQLite seeding`

---

## Prompt 5: Step 3, readiness engine + daily schedule

> Go ahead with step 3, is the CSV bundling necessary?

**Answer to the question:** bundling isn't strictly necessary, but it's the simplest way to meet "CSV seeded into the agent's SQL storage". The alternatives were hardcoded TypeScript arrays, fetching the files from static assets at startup, an R2 bucket, or D1. Each adds setup or moves state out of the agent for no demo benefit. In a real version, a scheduled job would load ERP or supplier-portal exports into the same tables, and the engine wouldn't change.

**Result:**

- **Engine:** `src/engine/readiness.ts` is a pure, deterministic engine (no LLM). Builds are processed by date, then region priority. Each build draws parts FIFO from supply lots and is graded `ready`, `at_risk` or `blocked`, with typed issues:
  - `shortage`: nothing committed at all
  - `late_commit`: the commit lands after the build date
  - `thin_buffer`: lands inside the 7-day buffer
  - `unreliable_supplier`: a risk-adjusted date (commit + the supplier's average slip) eats the buffer
  - `overdue_commit`: the commit date has passed but the parts aren't received
- **Persistence:** `src/engine/load.ts` and `src/engine/persist.ts` read inputs and save each run (`readiness_runs` + `build_status` tables). Every run is kept so later steps can diff them ("what changed").
- **Agent:**
  - runs a check right after seeding
  - schedules itself daily with cron `0 6 * * *` (SDK cron schedules are idempotent, so this is safe in `onStart`)
  - pushes the latest run summary to browsers through agent state
  - new methods the UI can call: `runReadinessCheckNow()` and `getLatestReadiness()`
- **Data tuning:**
  - The first run was 18 blocked / 18 at risk / 4 ready, because reliable suppliers' commits landed on top of build dates. I re-timed them, which left the problems in Nexwave (switches) and Lumora (optics).
  - I also replaced a blunt "any unreliable supplier = risk" rule with the risk-adjusted date.
  - Result: 10 ready / 22 at risk / 8 blocked.
- **Bug found and fixed:** a live run on a Sunday showed stock already on hand being flagged as "thin buffer". On-hand parts can't arrive late, so they are now exempt. Added a regression test.
- **Verification:**
  - 27 unit tests passing.
  - Ran the real Durable Object locally, with the AI binding temporarily removed since Workers AI needs a login. Confirmed: seed, check on seed, manual check, reset and the callable methods all work.

- **Upgrade fix (same prompt):** caught before handing back. An agent already seeded by step 2 would skip seeding on this deploy, so it would have no results tables and would keep the old data. Two fixes:
  - `onStart` now creates any missing tables.
  - A `DATA_VERSION` stored in `meta` makes the agent re-seed automatically when the CSVs change. Chat history is untouched.
  - Verified by seeding a local agent with the step 2 code, then starting the new code against the same stored data.

**Commits:** `feat: deterministic readiness engine, run history, daily schedule`, `fix: upgrade path for agents seeded by an older deploy`

---

## Prompt 6: Step 4, chat tools

> Deploy worked, go ahead with step 4

**Result:**

- **Query layer:** `src/tools/queries.ts` holds pure, read-only query functions behind the chat tools. The LLM never writes SQL or does supply math. It picks a tool, and the tool returns compact JSON: capped at 25 rows, issues reduced to one-line messages. Region names are flexible ("fra", "Frankfurt" and "FRA" all work).
- **Tools:** `src/tools/chat-tools.ts` defines five:
  - `getReadinessOverview`
  - `listProblemBuilds` (filter by geo, region, weeks, severity)
  - `getBuildDetail` (BOM, direct-ship eligibility)
  - `getSupplierScorecard`
  - `whatChanged`
- **Tolerant parameters:** Llama often sends `null`, `""` or `"3"` for optional fields, so those are cleaned up before validation. I checked the JSON schema the model receives and it's clean.
- **Agent:**
  - The system prompt is rebuilt every message with today's date and the week → build-date calendar, so "next month" maps to weeks 1–4.
  - Only the last 20 messages are sent to the model. All messages are still stored.
- **"What changed" on a fresh demo:** seeding now also records a reconstructed **baseline** run dated 7 days earlier, using suppliers' original commit dates (before slips). It's labelled `trigger = "baseline"` and the tool output says so. Once real week-old daily runs exist, those are preferred. `DATA_VERSION` was bumped to 3 so the live agent re-seeds with a baseline.
- **Verification:**
  - 41 tests pass (14 new).
  - Ran the real Durable Object locally without AI: it seeded at data version 3 with the baseline run and today's run.
  - The Llama tool-calling loop itself can only be tested on Cloudflare, so it's left for the deployed site.
- **Process slip:** the first step 4 commit was pushed even though typecheck failed on a test file, because of how the commands were chained. The deployed app wasn't affected: tests passed and the build doesn't typecheck test files. Fixed in a follow-up commit, and commits now run only if every check passes.

**Commits:** `feat: chat tools over readiness data + reconstructed baseline for what-changed`, `fix: test typing for tool input schema; log prompt 6`

---

## Prompt 7: Fix the GitHub Actions sanity check

> i am getting a check ubuntu 24.04 error and that node js is deprecated, this is for the sanity check, ensure this works then proceed to step 5

**Result:**

- **Real failure:** the CI log showed `npm run check` failing at `oxfmt --check .` on `PROMPTS.md` and the template's own `semgrep.yml`. The assistant had only been formatting `src/`, never running the full check script CI uses. Formatted both files; the changes are whitespace only, and no prompt text changed.
- **"Node.js 20 is deprecated":** a warning, not the failure. `actions/checkout@v4` and `actions/setup-node@v3` target Node 20. Moved to `@v5` of both (they run on Node 24) and pinned `node-version: 22`, the version the project is tested on.
- **Also:**
  - `npm ci` instead of `npm install`, for lockfile-exact installs
  - npm caching
  - `npm test` added, so CI runs the 41 unit tests
- **Verified:** ran the exact CI steps (`npm ci && npm run check && npm test`) on a clean clone; all pass.
- **Process change:** every commit from now on is gated on `npm run check && npm test`, the same as CI.

**Commits:** `ci: fix sanity check (formatting), Node 24 actions, run tests in CI`

**Step 5 (same prompt): weekly review Workflow with human approval**

- **What-if options:** `src/engine/options.ts` computes allocation options for each blocked build by re-running the deterministic engine on modified inputs. The LLM only explains options the engine has confirmed.
  - **Delay:** the smallest delay that unblocks the build (or "needs a new PO" when nothing is committed).
  - **Reallocate:** defer a lower-priority build that uses the same part, kept only if it actually unblocks; knock-on impacts are reported.
  - **Ship direct:** which parts can skip L11 integration.
  - All 8 blocked builds take 37 ms. Limitation: it tries one donor at a time, not combinations.
- **Facts pack:** `src/review/facts.ts` builds the only data the LLM sees: totals, change vs last week, options, and which suppliers to escalate. Escalation means slipped commits _and_ hurting builds now, so Orbit (reliable, just next in the queue) is excluded. The facts are stored with each review for audit.
- **Prompts:** `src/llm/prompts.ts` holds the report and email prompts (temperature 0.2, "use only these facts"), plus a deterministic fallback report and email so an AI outage never blocks the approval queue.
- **Workflow:** `src/workflows/weekly-review.ts` is `WeeklyReviewWorkflow extends AgentWorkflow`, with durable steps: compute, report (retried, then fallback), one email per supplier, save draft, `waitForApproval` (7-day timeout), then approved / rejected / expired. Nothing is "sent" without approval.
- **Approval queue:** `src/review/store.ts` holds the `weekly_reviews` table. Status changes are guarded, so retries and double-clicks can't move a review backwards.
- **Agent:**
  - browser-callable methods: `startWeeklyReview`, `approveReview`, `rejectReview`, `getReviews`, `getReviewDetail`
  - methods only the workflow can reach (over RPC): `prepareWeeklyReview`, `saveWeeklyReviewDraft`, `finalizeWeeklyReview`
  - `onWorkflowError` hook
  - weekly cron `0 7 * * 1`
  - the review row is created before the workflow starts, so a double-click is refused
- **Chat:** new `getWeeklyReview` tool gives access to past reports and decisions (memory).
- **Bugs found by running the real workflow locally (fallback path, no AI):**
  - `waitForApproval` returns the approval's `metadata`, not `reason`, so the note was lost.
  - The SDK reports a rejection as a workflow error, so rejections showed as "failed". The agent now records the rejection before signalling the workflow.
  - A missing AI binding was being retried with backoff. It now throws `NonRetryableError`.
  - The try/catch around the approval wait also caught failures from a later step. It's now narrowed to the wait only.
- **Verified:**
  - 57 tests pass, and `npm run check` is clean.
  - Locally: start → double-click refused → fallback draft and 2 emails → approve (note kept, emails released) → start → reject (note kept, emails discarded).
  - `wrangler deploy --dry-run` shows the `WEEKLY_REVIEW` Workflow binding.
  - The live Llama report/email quality can only be checked on Cloudflare.

**Commits (step 5):** `feat: weekly review Workflow with engine-verified options and human approval`
