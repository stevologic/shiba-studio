#!/usr/bin/env node
/**
 * Unattended Grok 4.6+ maintainer invoked by .github/workflows/grok-maintain.yml.
 *
 *   --validate / --dry-run   print mode+model and exit 0 (no API call)
 *   MAINTAIN_MODE=daily|weekly
 *   GROK_API_KEY missing     skip with a warning, exit 0
 *
 * Daily remediates high/critical vulns. Weekly assesses Claude / ChatGPT-Codex /
 * Grok / Cursor, ships at most one bounded increment, and may improve this
 * automation. Both write only to `development`; promotion to main stays in CI.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  TARGET_BRANCH,
  buildMaintainPrompt,
  fetchHostAllowed,
  formatValidateMessage,
  isValidateOnly,
  resolveMaintainMode,
  resolveScheduledModel,
  skipWithoutApiKey,
  toolBudgetForMode,
  writeAllowedForMode,
} from "./scheduled-maintain-lib.mjs";

const REPO_ROOT = process.cwd();
const argv = process.argv.slice(2);
const env = process.env;
const MODE = resolveMaintainMode({ env, argv, schedule: env.GITHUB_SCHEDULE || "" });
const MODEL = resolveScheduledModel(env);
const skip = skipWithoutApiKey(env);
const validateOnly = isValidateOnly(argv);
const BASE_URL = (env.GROK_BASE_URL ?? "https://api.x.ai/v1").replace(/\/+$/, "");
const SUMMARY_FILE = env.MAINTAIN_SUMMARY_FILE ?? path.join(REPO_ROOT, ".maintain-summary.txt");
const budget = toolBudgetForMode(MODE);
const MAX_STEPS = Number(env.MAINTAIN_MAX_STEPS ?? budget.maxSteps);
const TOOL_OUTPUT_LIMIT = 16_000;

function log(message) {
  console.log(message);
}

if (validateOnly || skip.skip) {
  if (skip.skip) {
    console.warn(skip.message);
  }
  log(formatValidateMessage({ mode: MODE, model: MODEL, skip: skip.skip }));
  process.exit(0);
}

const API_KEY = String(env.GROK_API_KEY || "").trim();

function fail(message) {
  console.error(`scheduled-maintain: ${message}`);
  process.exit(1);
}

function tail(text, limit) {
  if (text.length <= limit) return text;
  return `…[${text.length - limit} earlier chars truncated]…\n${text.slice(-limit)}`;
}

function sh(cmd, args, { timeoutMin = 5 } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: timeoutMin * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const timedOut = res.error?.code === "ETIMEDOUT";
  return { status: res.status, timedOut, output };
}

function resolveSafe(rel) {
  const abs = path.resolve(REPO_ROOT, rel);
  if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`Path escapes the repository: ${rel}`);
  }
  const inRepo = path.relative(REPO_ROOT, abs).replaceAll(path.sep, "/");
  if (inRepo === ".git" || inRepo.startsWith(".git/")) {
    throw new Error("The .git directory is off limits.");
  }
  return { abs, rel: inRepo };
}

const CHECKS = {
  typecheck: { cmd: ["npx", "tsc", "--noEmit"], timeoutMin: 10 },
  lint: { cmd: ["npm", "run", "lint"], timeoutMin: 10 },
  build: { cmd: ["npm", "run", "build"], timeoutMin: 25 },
  test: { cmd: ["npm", "test"], timeoutMin: 30 },
  audit: { cmd: ["npm", "audit", "--audit-level=high"], timeoutMin: 5 },
  audit_fix: { cmd: ["npm", "audit", "fix"], timeoutMin: 10 },
  npm_install: { cmd: ["npm", "install", "--no-audit", "--no-fund"], timeoutMin: 15 },
};

const PKG_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const editedFiles = new Set();
let doneState = null;

const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List tracked files, optionally filtered by a path substring.",
      parameters: {
        type: "object",
        properties: { filter: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a repository file with line numbers.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer" },
          end_line: { type: "integer" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "git grep (regex) over tracked files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path_glob: { type: "string" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_replace",
      description: "Replace an exact substring in an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Replace a file's entire contents (or create it).",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_check",
      description:
        "Run an allowlisted check: audit, audit_fix, npm_install, typecheck, test, lint, build, dep_tree, verify_script.",
      parameters: {
        type: "object",
        properties: {
          check: { type: "string" },
          script: { type: "string" },
          package: { type: "string" },
        },
        required: ["check"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "Finish. fixed=true only when the working tree has a verified change.",
      parameters: {
        type: "object",
        properties: {
          fixed: { type: "boolean" },
          summary: { type: "string" },
        },
        required: ["fixed", "summary"],
      },
    },
  },
];

if (budget.fetchEnabled) {
  TOOL_SPECS.splice(TOOL_SPECS.length - 1, 0, {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "Fetch a public documentation page (Claude, ChatGPT/Codex, Grok/xAI, Cursor, GitHub). Host allowlist is enforced.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  });
}

function runTool(name, args) {
  switch (name) {
    case "list_files": {
      const res = sh("git", ["ls-files"]);
      let files = res.output.split("\n").filter(Boolean);
      if (args.filter) {
        const needle = String(args.filter).toLowerCase();
        files = files.filter((f) => f.toLowerCase().includes(needle));
      }
      const capped = files.slice(0, 400);
      return `${capped.join("\n")}${files.length > 400 ? `\n…and ${files.length - 400} more` : ""}` || "(no matches)";
    }
    case "read_file": {
      const { abs, rel } = resolveSafe(String(args.path));
      if (/(^|\/)package-lock\.json$/.test(rel) || /(^|\/)node_modules\//.test(rel)) {
        return `ERROR: reading ${rel} wastes budget. Use run_check dep_tree or audit.`;
      }
      if (!existsSync(abs)) return `ERROR: ${rel} does not exist.`;
      const lines = readFileSync(abs, "utf8").split("\n");
      const start = Math.max(1, Number(args.start_line ?? 1));
      const end = Math.min(lines.length, Number(args.end_line ?? lines.length));
      const slice = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`);
      return `${rel} (${lines.length} lines total)\n${tail(slice.join("\n"), TOOL_OUTPUT_LIMIT)}`;
    }
    case "search": {
      const cmdArgs = ["grep", "-n", "-I", "-e", String(args.pattern), "--"];
      cmdArgs.push(args.path_glob ? String(args.path_glob) : ".");
      cmdArgs.push(":(exclude)package-lock.json", ":(exclude)*/package-lock.json");
      const res = sh("git", cmdArgs);
      if (res.status === 1) return "(no matches)";
      return tail(res.output, TOOL_OUTPUT_LIMIT);
    }
    case "search_replace":
    case "write_file": {
      const { abs, rel } = resolveSafe(String(args.path));
      if (!writeAllowedForMode(MODE, rel)) {
        return `ERROR: writing to ${rel} is not permitted in ${MODE} mode.`;
      }
      if (name === "write_file") {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, String(args.content));
        editedFiles.add(rel);
        return `Wrote ${rel} (${String(args.content).length} chars).`;
      }
      if (!existsSync(abs)) return `ERROR: ${rel} does not exist.`;
      const current = readFileSync(abs, "utf8");
      const oldString = String(args.old_string);
      const newString = String(args.new_string);
      if (!oldString) return "ERROR: old_string must not be empty.";
      if (oldString === newString) return "ERROR: old_string and new_string are identical.";
      const occurrences = current.split(oldString).length - 1;
      if (occurrences === 0) return `ERROR: old_string was not found in ${rel}.`;
      if (occurrences > 1 && !args.replace_all) {
        return `ERROR: old_string matched ${occurrences} times in ${rel}. Pass replace_all=true or add context.`;
      }
      const next = args.replace_all
        ? current.split(oldString).join(newString)
        : current.replace(oldString, newString);
      writeFileSync(abs, next);
      editedFiles.add(rel);
      return `Updated ${rel} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`;
    }
    case "run_check": {
      const check = String(args.check || "");
      if (check !== "dep_tree" && check !== "verify_script" && !budget.checks.includes(check)) {
        return `ERROR: check '${check}' is not allowlisted for ${MODE} mode.`;
      }
      let spec;
      if (check === "dep_tree") {
        const pkg = String(args.package ?? "");
        if (!PKG_NAME_RE.test(pkg)) return `ERROR: '${pkg}' is not a valid npm package name.`;
        spec = { cmd: ["npm", "ls", pkg, "--all"], timeoutMin: 3 };
      } else if (check === "verify_script") {
        const script = String(args.script ?? "");
        if (!/^verify-[a-z0-9-]+\.ts$/.test(script) || !existsSync(path.join(REPO_ROOT, "scripts", script))) {
          return `ERROR: unknown verify script '${script}'.`;
        }
        spec = { cmd: ["npx", "tsx", `scripts/${script}`], timeoutMin: 10 };
      } else {
        spec = CHECKS[check];
        if (!spec) return `ERROR: unknown check '${check}'.`;
      }
      log(`  running: ${spec.cmd.join(" ")}`);
      const res = sh(spec.cmd[0], spec.cmd.slice(1), { timeoutMin: spec.timeoutMin });
      const verdict = res.timedOut ? "TIMED OUT" : res.status === 0 ? "PASSED" : `FAILED (exit ${res.status})`;
      return `${verdict}\n${tail(res.output, TOOL_OUTPUT_LIMIT)}`;
    }
    case "fetch_url": {
      if (!budget.fetchEnabled) return "ERROR: fetch_url is weekly-only.";
      const url = String(args.url || "");
      if (!fetchHostAllowed(url)) {
        return `ERROR: host is not on the weekly research allowlist: ${url}`;
      }
      return fetch(url, { headers: { "user-agent": "shiba-studio-scheduled-maintain/1.0" }, redirect: "follow" })
        .then(async (res) => {
          const text = await res.text();
          return `HTTP ${res.status} ${url}\n${tail(text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), 12_000)}`;
        })
        .catch((err) => `ERROR: fetch failed: ${err.message}`);
    }
    case "done": {
      doneState = { fixed: Boolean(args.fixed), summary: String(args.summary ?? "").trim() };
      return "Acknowledged.";
    }
    default:
      return `ERROR: unknown tool '${name}'.`;
  }
}

async function chat(messages) {
  const body = JSON.stringify({ model: MODEL, messages, tools: TOOL_SPECS, tool_choice: "auto" });
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
        body,
      });
      if (res.ok) {
        const data = await res.json();
        const msg = data.choices?.[0]?.message;
        if (!msg) throw new Error("retryable: response had no choices");
        return msg;
      }
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`retryable ${res.status}: ${text.slice(0, 300)}`);
      }
      fail(`Grok API error ${res.status}: ${text.slice(0, 2000)}`);
    } catch (err) {
      if (attempt === 5) fail(`Grok API unreachable after 5 attempts: ${err.message}`);
      const delayMs = 2 ** attempt * 1000;
      console.error(`scheduled-maintain: ${err.message} — retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

function collectDailyAudit() {
  const res = sh("npm", ["audit", "--audit-level=high"], { timeoutMin: 5 });
  return `npm audit --audit-level=high (exit ${res.status})\n${tail(res.output, 20_000)}`;
}

async function main() {
  log(`scheduled-maintain: starting mode=${MODE} model=${MODEL} target=${TARGET_BRANCH}`);
  const recent = sh("git", ["log", "-8", "--format=%h %s"]).output.trim();
  const extras = MODE === "daily" ? `\n\nCurrent vulnerability report:\n${collectDailyAudit()}` : "";
  const messages = [
    { role: "system", content: buildMaintainPrompt(MODE, { model: MODEL }) },
    {
      role: "user",
      content: `Repository context:\n- Target branch: ${TARGET_BRANCH} (never main)\n- HEAD:\n${recent}\n- Node: ${process.version}${extras}`,
    },
  ];

  let nudges = 0;
  for (let step = 1; step <= MAX_STEPS && !doneState; step++) {
    const remaining = MAX_STEPS - step;
    if (remaining === 12) {
      messages.push({
        role: "user",
        content: "Budget warning: only 12 tool calls remain. Finish or call done.",
      });
    }
    const msg = await chat(messages);
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) {
      if (++nudges > 2) fail("Model stopped calling tools without calling done.");
      messages.push({ role: "user", content: "Continue with tool calls; call `done` when finished." });
      continue;
    }
    nudges = 0;
    for (const call of msg.tool_calls) {
      let result;
      let argsForLog = "";
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        argsForLog = args.path ?? args.check ?? args.url ?? args.pattern ?? "";
        result = runTool(call.function.name, args);
        if (result && typeof result.then === "function") result = await result;
      } catch (err) {
        result = `ERROR: ${err.message}`;
      }
      log(`[step ${step}] ${call.function.name} ${argsForLog}`.trim());
      messages.push({ role: "tool", tool_call_id: call.id, content: tail(String(result), TOOL_OUTPUT_LIMIT) });
    }
  }

  if (!doneState) fail(`Step budget (${MAX_STEPS}) exhausted without a done call.`);

  const dirty = sh("git", ["status", "--porcelain"]).output.trim();
  if (!doneState.fixed) {
    log(`scheduled-maintain: no change this run — ${doneState.summary}`);
    writeFileSync(SUMMARY_FILE, `${doneState.summary || "no change"}\n`);
    process.exit(0);
  }
  if (!dirty) fail("Grok reported a change but the working tree is unchanged.");

  const oneLine = doneState.summary.replace(/\s+/g, " ").trim().slice(0, 80) || `${MODE} maintenance`;
  writeFileSync(SUMMARY_FILE, `${oneLine}\n`);
  log(`scheduled-maintain: applied — ${oneLine}\n${dirty}`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `## Scheduled maintain (${MODE})\n\n**Model:** ${MODEL}\n\n**Change:** ${oneLine}\n\n\`\`\`\n${dirty}\n\`\`\`\n`,
    );
  }
}

await main();
