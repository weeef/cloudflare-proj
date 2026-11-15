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
