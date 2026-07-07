# Automations

The Automations page is where everything that *runs* lives: schedules, live execution traces, and per-schedule run logs.

## Schedules

Each agent can have multiple schedule entries, each with:

- a **cron expression** (with human-readable presets — hourly, daily, weekdays, …),
- its **own instructions** — the prompt used for that scheduled run,
- its own row on the automation card, with an **Active/Paused pill** and **edit/delete** controls right next to the cron.

Add a schedule with the card's calendar button (or Agents → Edit → Schedules); pause, edit, or delete any individual automation from its row. Only agents that actually have schedules appear on the page.

## Headless operation

Schedules fire **as long as the server is running — no browser needed**. Cron arms at server start (`instrumentation.ts` → the scheduler), so `npm run start` on a box in the closet is a fully functional automation host. Every arm/fire/retire is recorded in the audit log.

If an agent is deleted, its schedule **retires itself** at the next fire attempt instead of running an orphan — you'll find a `schedule retired` entry in Logs.

## Run log

Each automation card shows its last scheduled executions — status, time, and instructions — and every entry opens the full trace. Each schedule row has its own **Run now** (▶) that fires that automation's instructions immediately.

## Execution Trace

The live trace at the bottom of the page streams every step of a run:

- model **thoughts**, **tool calls** with arguments, and tool **results**,
- **screenshots** from browser automation and generated images inline,
- a **preview rail** of visual steps and a **workspace diff** panel after completion,
- the final answer with its model badge.

Runs started anywhere (dashboard, agent history, Logs deep links `/automations?run=<id>`) hydrate here — click a run row anywhere in the app and you land on its full log with the agent's config open.

## Orchestration

Agents can manage themselves and each other:

- `schedule_task(when, prompt)` — an agent schedules its own follow-up ("in 30m" or cron).
- `send_to_peer(agentId, message)` — queue a message for a peer agent's next run.

Everything is scoped per agent and audited.
