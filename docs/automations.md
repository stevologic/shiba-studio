# Automations

The **Automations** page at `/automations` is the single home for durable recurring, one-time, monitored, event-driven, and manually started work. Agents are execution owners selected by an Automation; they do not carry a separate schedule configuration.

<img src="images/automations.png" alt="Automations: durable trigger-based work with Active/Paused states, Run/Edit/Delete controls, and run-history access" width="880" />

## Define an Automation

An Automation can be run manually or activated by one or more triggers:

- cron and natural-language one-time schedules;
- generic HMAC-signed webhooks with replay and delivery deduplication;
- GitHub, Linear, Jira, Slack, Discord, or other normalized integration events;
- bounded filesystem changes and local URL/process health checks.

Definitions support template parameters, conditions, dependent steps, exponential retry/backoff, timeouts, concurrency keys, catch-up policies, and a circuit breaker. Repeated failures open the Automation's visible circuit breaker and remain available in its task/run history; they do not create Attention noise. Each invocation and step uses durable leases/checkpoints, so duplicate webhook delivery or a restart cannot silently duplicate a side effect. Definitions can be exported as JSON or YAML.

The stable API and persisted model call these definitions **Routines** (`/api/routines`). That technical terminology remains for compatibility, while the Studio presents them as Automations.

Starting from a successful run or reviewed Capability Pack remains proposal-first: a user must activate the resulting Automation before it can fire.

Each Automation selects one agent as its **execution owner**. The owner supplies the model, workspace, tools, integration scopes, skills, and memory used by its steps. The Automation owns the prompt, triggers, enabled state, retry and concurrency policy, and workflow definition.

## Manage work in one place

Create, edit, activate, pause, run, and delete Automations from `/automations`. Each card shows its owner, trigger summary, Active/Paused state, last invocation, and direct access to run history. **Run now** uses the saved definition through the same durable invocation path as every automatic trigger.

Cron is one trigger type, not a separate management system. Scheduled triggers use a standard five-field expression and optional timezone; one-time triggers accept an exact future time. A single Automation may contain multiple triggers while retaining one definition and history.

## Headless operation

Automations fire **as long as the server is running — no browser needed**. `/api/boot` ensures that one process-global Automation engine is active, and server instrumentation eagerly invokes the same idempotent initializer for headless startup. This is one engine: a page load does not create another engine or stop and re-arm existing work. `npm run start` on a box in the closet is therefore a fully functional automation host.

Every trigger claim, invocation lease, retry, completion, and circuit state is durable. Duplicate webhooks or trigger ticks are deduplicated, expired workers are recovered within the retry policy, and a one-time trigger is consumed exactly once. If an execution owner is removed, integrity cleanup safely retires its Automations and skips pending work instead of leaving an orphaned invocation.

**Overlap & cost safety.** A concurrency key can suppress overlapping invocations instead of stacking duplicate work. Cloud-model Automations respect connectivity checks, and the global concurrent-run limit plus monthly/daily spend caps (Settings → Cost & safety) apply to every invocation. Scheduled triggers accept only validated five-field cron expressions.

## Run history

Each Automation card shows recent invocations with status, trigger, time, and instructions, and every entry opens the full trace. **Run now** fires the saved Automation immediately without creating a second execution path.

## Execution Trace

The trace lives in a modal so the page stays clean — it opens automatically when you press **Run now** or follow a run link, and any time from the **View trace** bar at the bottom of the page. Inside, every step of a run streams live:

- model **thoughts**, **tool calls** with arguments, and tool **results**,
- **screenshots** from browser automation and generated images inline,
- a **preview rail** of visual steps and a **workspace diff** panel after completion,
- the final answer with its model badge.

Runs started anywhere (dashboard, agent history, Logs deep links `/automations?run=<id>`) hydrate here — click a run row anywhere in the app and you land on its full log with the agent's config open.

## Orchestration

Agents can manage themselves and each other:

- `schedule_task(when, prompt)` — creates a durable Automation assigned to the calling agent. Relative/date-like input creates a one-time trigger; a standard five-field cron expression creates recurring work.
- `send_to_peer(agentId, message)` — queue a message for a peer agent's next run.

Execution remains scoped to the selected owner and every definition change, trigger, invocation, and side effect is audited.
