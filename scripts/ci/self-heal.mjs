#!/usr/bin/env node
/**
 * Grok-powered CI repair agent, invoked by the `self-heal` job in
 * .github/workflows/ci.yml when CI fails on the `development` branch.
 *
 * Reads the failed jobs' logs (FAILURE_LOG_DIR), lets Grok inspect and edit
 * the working tree through a constrained tool loop, and exits 0 only when
 * Grok reports a fix AND the working tree actually changed. The workflow
 * then gates on `tsc --noEmit`, commits, pushes, and re-dispatches CI.
 *
 * Safety rails (enforced here, not just prompted):
 *  - writes are confined to the repository, and never to .github/,
 *    scripts/ci/, package-lock.json, or node_modules
 *  - shell access is limited to a fixed allowlist of verification commands
 *  - hard budget on tool-loop steps and per-tool output size
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const API_KEY = process.env.GROK_API_KEY;
const BASE_URL = (process.env.GROK_BASE_URL ?? "https://api.x.ai/v1").replace(/\/+$/, "");
const MODEL = process.env.GROK_MODEL || "grok-4.6";
const LOG_DIR = process.env.FAILURE_LOG_DIR ?? "";
const SUMMARY_FILE = process.env.SELF_HEAL_SUMMARY_FILE ?? "/tmp/self-heal-summary.txt";
const MAX_STEPS = Number(process.env.SELF_HEAL_MAX_STEPS ?? 60);
const TOOL_OUTPUT_LIMIT = 16_000;
const LOG_BUDGET = 80_000;

function fail(message) {
  console.error(`self-heal: ${message}`);
  process.exit(1);
}

if (!API_KEY) fail("GROK_API_KEY is not set.");
if (!LOG_DIR || !existsSync(LOG_DIR)) fail(`FAILURE_LOG_DIR (${LOG_DIR || "unset"}) does not exist.`);

// ---------------------------------------------------------------- utilities

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

/** Resolve a model-supplied path, refusing anything outside the repo. */
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

const WRITE_DENYLIST = [
  /^\.github\//,
  /^scripts\/ci\//,
  /(^|\/)package-lock\.json$/,
  /(^|\/)node_modules\//,
];

// ------------------------------------------------------------------- checks

const CHECKS = {
  typecheck: { cmd: ["npx", "tsc", "--noEmit"], timeoutMin: 10 },
  lint: { cmd: ["npm", "run", "lint"], timeoutMin: 10 },
  build: { cmd: ["npm", "run", "build"], timeoutMin: 25 },
  test: { cmd: ["npm", "test"], timeoutMin: 30 },
  audit: { cmd: ["npm", "audit", "--audit-level=high"], timeoutMin: 5 },
  audit_fix: { cmd: ["npm", "audit", "fix"], timeoutMin: 10 },
  npm_install: { cmd: ["npm", "install", "--no-audit", "--no-fund"], timeoutMin: 15 },
  devvit_verify: { cmd: ["npm", "--prefix", "devvit/reddit-bridge", "run", "verify"], timeoutMin: 10 },
};

const PKG_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

// -------------------------------------------------------------------- tools

const editedFiles = new Set();
let doneState = null;

const TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List tracked files in the repository, optionally filtered by a substring of the path.",
      parameters: {
        type: "object",
        properties: { filter: { type: "string", description: "Case-insensitive substring to filter paths by." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the repository, with line numbers. Optionally a line range.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          start_line: { type: "integer", description: "1-based first line to include." },
          end_line: { type: "integer", description: "1-based last line to include." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search",
      description: "Search tracked files with git grep (regex). Returns path:line:match lines.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path_glob: { type: "string", description: "Optional pathspec, e.g. 'components/*.tsx'." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Replace a file's entire contents (or create a new file). Provide the complete file.",
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
      name: "search_replace",
      description:
        "Replace an exact substring in an existing file. Prefer this over write_file for surgical edits. Fails if old_string is not found or matches more than once (unless replace_all is true).",
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
      name: "run_check",
      description:
        "Run one of the CI verification commands: typecheck (tsc --noEmit), lint, build, test (full verify suite), audit, audit_fix (npm audit fix), npm_install (sync package-lock.json and node_modules after editing package.json — required after changing dependencies or overrides), dep_tree (npm ls <package> --all; pass `package` to see every path a dependency reaches the tree by), devvit_verify, or verify_script (a single scripts/verify-*.ts via tsx; pass `script`).",
      parameters: {
        type: "object",
        properties: {
          check: {
            type: "string",
            enum: [...Object.keys(CHECKS), "dep_tree", "verify_script"],
          },
          script: { type: "string", description: "For verify_script: file name like 'verify-theme.ts'." },
          package: { type: "string", description: "For dep_tree: the npm package name to trace." },
        },
        required: ["check"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description: "Finish. Call with fixed=true only after your verification checks pass.",
      parameters: {
        type: "object",
        properties: {
          fixed: { type: "boolean" },
          summary: {
            type: "string",
            description: "One line (<80 chars) describing the fix — it becomes the commit message.",
          },
        },
        required: ["fixed", "summary"],
      },
    },
  },
];

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
        return `ERROR: reading ${rel} wastes your budget — it is huge and truncated. Use run_check "dep_tree" with a package name to trace dependencies, or run_check "audit" for advisory details.`;
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
    case "write_file": {
      const { abs, rel } = resolveSafe(String(args.path));
      if (WRITE_DENYLIST.some((re) => re.test(rel))) {
        return `ERROR: writing to ${rel} is not permitted for the self-heal agent.`;
      }
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, String(args.content));
      editedFiles.add(rel);
      return `Wrote ${rel} (${String(args.content).length} chars).`;
    }
    case "search_replace": {
      const { abs, rel } = resolveSafe(String(args.path));
      if (WRITE_DENYLIST.some((re) => re.test(rel))) {
        return `ERROR: writing to ${rel} is not permitted for the self-heal agent.`;
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
        return `ERROR: old_string matched ${occurrences} times in ${rel}. Pass replace_all=true or include more surrounding context.`;
      }
      const next = args.replace_all
        ? current.split(oldString).join(newString)
        : current.replace(oldString, newString);
      writeFileSync(abs, next);
      editedFiles.add(rel);
      return `Updated ${rel} (${occurrences} replacement${occurrences === 1 ? "" : "s"}).`;
    }
    case "run_check": {
      let spec;
      if (args.check === "dep_tree") {
        const pkg = String(args.package ?? "");
        if (!PKG_NAME_RE.test(pkg)) return `ERROR: '${pkg}' is not a valid npm package name.`;
        spec = { cmd: ["npm", "ls", pkg, "--all"], timeoutMin: 3 };
      } else if (args.check === "verify_script") {
        const script = String(args.script ?? "");
        if (!/^verify-[a-z0-9-]+\.ts$/.test(script) || !existsSync(path.join(REPO_ROOT, "scripts", script))) {
          return `ERROR: unknown verify script '${script}'.`;
        }
        spec = { cmd: ["npx", "tsx", `scripts/${script}`], timeoutMin: 10 };
      } else {
        spec = CHECKS[args.check];
        if (!spec) return `ERROR: unknown check '${args.check}'.`;
      }
      console.log(`  running: ${spec.cmd.join(" ")}`);
      const res = sh(spec.cmd[0], spec.cmd.slice(1), { timeoutMin: spec.timeoutMin });
      const verdict = res.timedOut ? "TIMED OUT" : res.status === 0 ? "PASSED" : `FAILED (exit ${res.status})`;
      return `${verdict}\n${tail(res.output, TOOL_OUTPUT_LIMIT)}`;
    }
    case "done": {
      doneState = { fixed: Boolean(args.fixed), summary: String(args.summary ?? "").trim() };
      return "Acknowledged.";
    }
    default:
      return `ERROR: unknown tool '${name}'.`;
  }
}

// ------------------------------------------------------------- failure logs

function collectFailureLogs() {
  const files = readdirSync(LOG_DIR).filter((f) => f.endsWith(".log")).sort();
  if (files.length === 0) fail("No failure logs were collected.");
  const perFile = Math.max(8_000, Math.floor(LOG_BUDGET / files.length));
  const stripTs = (l) => l.replace(/^[^\s]*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, "");
  return files
    .map((f) => {
      const lines = readFileSync(path.join(LOG_DIR, f), "utf8").split(/\r?\n/).map(stripTs);
      const errors = lines.filter((l) => l.includes("##[error]")).slice(0, 120);
      const last = lines.slice(-220);
      let section = errors.length ? `--- error lines ---\n${errors.join("\n")}\n` : "";
      section += `--- last ${last.length} lines ---\n${last.join("\n")}`;
      return `===== Failed job: ${f.replace(/\.log$/, "")} =====\n${tail(section, perFile)}`;
    })
    .join("\n\n");
}

// ---------------------------------------------------------------- Grok API

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
      console.error(`self-heal: ${err.message} — retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// --------------------------------------------------------------------- main

const SYSTEM_PROMPT = `You are the automated CI-repair agent for Shiba Studio, a local-first Next.js 16 agent studio (repository root is the working directory). CI failed on the \`development\` branch. Find the root cause in the failure logs, apply the smallest correct fix, verify it, then call \`done\`.

Hard rules:
- Fix the root cause. Never delete or skip tests, never loosen a check, and never silence errors with eslint-disable, @ts-ignore, or @ts-expect-error.
- Never weaken security enforcement: proxy.ts (rejects non-loopback-Origin /api/* requests) and lib/terminal-server.ts (rejects non-loopback WebSocket origins) must keep rejecting.
- Writes to .github/, scripts/ci/, package-lock.json, and node_modules are blocked. The lockfile changes only through npm itself: run_check "audit_fix" or run_check "npm_install".
- npm audit playbook: run_check "audit_fix" first; if high/critical advisories remain, read the audit output to find the ROOT advisories (packages with their own CVE, not "depends on vulnerable"), trace them with run_check "dep_tree", then add minimal pinned entries to the "overrides" block in package.json (the patched version is usually one patch above the vulnerable range), run_check "npm_install" to sync the lockfile, and run_check "audit" to confirm. Never grep or read package-lock.json — dep_tree answers dependency questions.
- Some scripts/verify-*.ts checks assert literal source strings from the UI. If a deliberate source change broke such an assertion, update the assertion to match the new source; otherwise fix the source.
- If you change behavior, update the matching page under docs/.

Method:
1. Identify each distinct failure in the logs (first user message).
2. Inspect the relevant code with read_file/search before editing.
3. Apply fixes with write_file (always provide the complete file contents).
4. Verify: always run_check "typecheck"; additionally re-run what failed ("test", "build", "lint", "audit", "devvit_verify", or a targeted "verify_script"). The Playwright and Docker jobs cannot run here — for those, reason from the logs and code.
5. Call done with fixed=true and a one-line summary (it becomes the commit message) only after verification passes. If the failure is not fixable from inside the repository (e.g. infrastructure flake), call done with fixed=false and say why.

Budget: at most ${MAX_STEPS} tool calls — be economical; read only what you need.`;

async function main() {
  const recent = sh("git", ["log", "-8", "--format=%h %s"]).output.trim();
  const intro = `Repository context:
- HEAD and recent commits:
${recent}
- Node: ${process.version}

Failure logs from the failed CI jobs follow.

${collectFailureLogs()}`;

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: intro },
  ];

  let nudges = 0;
  for (let step = 1; step <= MAX_STEPS && !doneState; step++) {
    const remaining = MAX_STEPS - step;
    if (remaining === 12) {
      messages.push({
        role: "user",
        content: "Budget warning: only 12 tool calls remain. Stop exploring — apply your best fix now, verify it, and call `done`.",
      });
    }
    const msg = await chat(messages);
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) {
      if (msg.content) console.log(`[step ${step}] (no tool call) ${tail(String(msg.content), 600)}`);
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
        argsForLog = args.path ?? args.check ?? args.pattern ?? args.filter ?? "";
        result = runTool(call.function.name, args);
      } catch (err) {
        result = `ERROR: ${err.message}`;
      }
      console.log(`[step ${step}] ${call.function.name} ${argsForLog}`.trim());
      messages.push({ role: "tool", tool_call_id: call.id, content: tail(String(result), TOOL_OUTPUT_LIMIT) });
    }
  }

  if (!doneState) fail(`Step budget (${MAX_STEPS}) exhausted without a done call.`);
  if (!doneState.fixed) fail(`Grok reported the failure as unfixable: ${doneState.summary}`);

  const dirty = sh("git", ["status", "--porcelain"]).output.trim();
  if (!dirty) fail("Grok reported a fix but the working tree is unchanged.");

  const oneLine = doneState.summary.replace(/\s+/g, " ").trim().slice(0, 80) || "automated repair";
  writeFileSync(SUMMARY_FILE, `${oneLine}\n`);

  const diffStat = sh("git", ["diff", "--stat"]).output.trim();
  console.log(`\nself-heal: fix applied — ${oneLine}\n\nChanged files:\n${dirty}\n\n${diffStat}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Self-heal (Grok)\n\n**Model:** ${MODEL}\n\n**Fix:** ${oneLine}\n\n\`\`\`\n${dirty}\n\`\`\`\n`,
    );
  }
}

await main();
