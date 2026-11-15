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
> 1. LLM — recommended Llama 3.3 on Workers AI (@cf/meta/llama-3.3-70b-instruct-fp8-fast)
> 2. Workflow / coordination — Workflows, Workers, or Durable Objects
> 3. User input via chat or voice — Pages or Realtime
> 4. Memory or state
> - AI-assisted coding is encouraged, but I MUST submit prompt history. Log every prompt I send in PROMPTS.md as we go (I'll paste them; remind me if I forget).
> - Docs: https://developers.cloudflare.com/agents/
>
> **The role (what the agent should mirror).** The job owns the supply-planning interface between capacity demand, L10 server/network hardware supply, and L11 full-rack integration at global integration partners. Key duties: weekly supply allocation reporting and shortage reviews, material-readiness assessments for upcoming rack builds, presenting allocation options/tradeoffs to Capacity Planning (incl. direct hardware ship vs. full rack integration), supplier business reviews (capacity, delivery, cost, quality), supply risk (bottlenecks, logistics, tariffs, regional concentration), executive reporting.
>
> **What to build**
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
