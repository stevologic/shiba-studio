/**
 * Testable policy for unattended Grok 4.6+ maintenance.
 * The workflow and scheduled-maintain.mjs both import this file — tests
 * must call these functions, not a reimplementation.
 */

import { spawnSync } from "node:child_process";

export const DEFAULT_SCHEDULED_GROK_MODEL = "grok-4.6";
export const TARGET_BRANCH = "development";
export const CRON_DAILY = "17 6 * * *";
export const CRON_WEEKLY = "17 7 * * 1";
export const SKIP_NO_KEY_MESSAGE = "scheduled-maintain: skipped (GROK_API_KEY is not set)";

const STALE_UNATTENDED_MODELS = new Set([
  "grok-4.5",
  "grok-4",
  "grok-code-fast-1",
  "grok-3",
  "grok-2",
]);

export const FETCH_HOST_ALLOWLIST = [
  "docs.x.ai",
  "x.ai",
  "docs.anthropic.com",
  "platform.claude.com",
  "code.claude.com",
  "platform.openai.com",
  "help.openai.com",
  "developers.openai.com",
  "learn.chatgpt.com",
  "cursor.com",
  "docs.cursor.com",
  "github.com",
];

/**
 * @param {string | undefined | null} model
 * @returns {boolean}
 */
export function isGrok46OrLater(model) {
  const id = String(model || "").trim().toLowerCase();
  if (!id) return false;
  if (id === "grok-latest") return true;
  if (STALE_UNATTENDED_MODELS.has(id)) return false;
  const dated = id.match(/^grok-(\d+)(?:\.(\d+))?/);
  if (!dated) return false;
  const major = Number(dated[1]);
  const minor = Number(dated[2] || 0);
  if (major > 4) return true;
  if (major === 4 && minor >= 6) return true;
  return false;
}

/**
 * Unattended default is always Grok 4.6+. A configured GROK_MODEL is honored
 * only when it is itself 4.6 or later — cheap/stale healer ids are ignored.
 */
/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveScheduledModel(env = process.env) {
  const requested = String(env.GROK_MODEL || "").trim();
  if (requested && isGrok46OrLater(requested)) return requested;
  return DEFAULT_SCHEDULED_GROK_MODEL;
}

/**
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   argv?: string[],
 *   schedule?: string,
 * }} [opts]
 * @returns {'daily' | 'weekly'}
 */
export function resolveMaintainMode({
  env = process.env,
  argv = process.argv.slice(2),
  schedule = env.GITHUB_SCHEDULE || "",
} = {}) {
  const flag = argv.find((arg) => arg.startsWith("--mode="));
  if (flag) {
    const value = flag.slice("--mode=".length).trim().toLowerCase();
    if (value === "weekly" || value === "daily") return value;
  }
  const fromEnv = String(env.MAINTAIN_MODE || "").trim().toLowerCase();
  if (fromEnv === "weekly" || fromEnv === "daily") return fromEnv;
  if (String(schedule).trim() === CRON_WEEKLY) return "weekly";
  return "daily";
}

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ skip: boolean, message: string }}
 */
export function skipWithoutApiKey(env = process.env) {
  const key = String(env.GROK_API_KEY || "").trim();
  if (key) return { skip: false, message: "" };
  return { skip: true, message: SKIP_NO_KEY_MESSAGE };
}

export function isValidateOnly(argv = process.argv.slice(2)) {
  return argv.includes("--validate") || argv.includes("--dry-run");
}

export function toolBudgetForMode(mode) {
  if (mode === "weekly") {
    return {
      maxSteps: 80,
      checks: [
        "audit",
        "audit_fix",
        "npm_install",
        "typecheck",
        "lint",
        "test",
        "build",
        "dep_tree",
        "verify_script",
      ],
      fetchEnabled: true,
    };
  }
  return {
    maxSteps: 40,
    checks: ["audit", "audit_fix", "npm_install", "typecheck", "test", "dep_tree"],
    fetchEnabled: false,
  };
}

export function isGithubWorkflowPath(relPath) {
  const rel = String(relPath || "").replaceAll("\\", "/").replace(/^\.\//, "");
  return rel === ".github/workflows" || rel.startsWith(".github/workflows/");
}

export function writeAllowedForMode(mode, relPath) {
  const rel = String(relPath || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!rel || rel === ".git" || rel.startsWith(".git/")) return false;
  if (rel === "node_modules" || rel.startsWith("node_modules/")) return false;
  if (/(^|\/)package-lock\.json$/.test(rel)) return false;
  // GITHUB_TOKEN cannot create or update workflow files. Editing them makes
  // the later `git push` fail the whole job.
  if (isGithubWorkflowPath(rel)) return false;
  if (mode === "weekly") return true;
  if (rel.startsWith(".github/")) return false;
  if (rel.startsWith("scripts/ci/")) return false;
  return true;
}

export function fetchHostAllowed(url) {
  let host;
  try {
    host = new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return false;
  }
  return FETCH_HOST_ALLOWLIST.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

const FETCH_DOC_LIMIT = 12_000;

function decodeBasicEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function collapseWhitespace(text) {
  return decodeBasicEntities(text).replace(/\s+/g, " ").trim();
}

function looksLikeRenderedShell(text) {
  const sample = String(text || "").slice(0, 4_000);
  return /self\.__next_f\.push|window\.__CF\$cv\$params|__NEXT_DATA__/.test(sample);
}

/**
 * Pull human-readable prose out of Next.js RSC / JS app shells so weekly
 * research is not just minified flight data.
 * @param {string} raw
 * @returns {string}
 */
export function extractQuotedProse(raw) {
  const matches = String(raw || "").match(/"(?:\\.|[^"\\]){40,500}"/g) || [];
  const seen = new Set();
  const lines = [];
  for (const match of matches) {
    const value = collapseWhitespace(
      match
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, " ")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
        .replace(/<[^>]+>/g, " "),
    );
    if (value.length < 40) continue;
    if (!/[A-Za-z]{4,}\s+[A-Za-z]/.test(value)) continue;
    if (/^(https?:|\/_next\/|static\/chunks)/.test(value)) continue;
    if (/function\s*\(|=>\s*\{|self\.__next_f|window\.__CF/.test(value)) continue;
    const key = value.slice(0, 160);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(value);
    if (lines.length >= 48) break;
  }
  return lines.join("\n");
}

/**
 * Reduce a fetched documentation body to inspectable text.
 * @param {string} body
 * @param {{ maxChars?: number }} [opts]
 * @returns {string}
 */
export function extractFetchedDocText(body, { maxChars = FETCH_DOC_LIMIT } = {}) {
  const raw = String(body || "");
  const withoutChrome = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const stripped = collapseWhitespace(withoutChrome);
  const usable = looksLikeRenderedShell(raw) || stripped.length < 200
    ? extractQuotedProse(raw) || stripped
    : stripped;
  if (usable.length <= maxChars) return usable;
  return `…[${usable.length - maxChars} earlier chars truncated]…\n${usable.slice(-maxChars)}`;
}

/**
 * Format a weekly fetch_url result. Rejects redirects that leave the allowlist.
 * @param {{ url: string, status: number, finalUrl?: string, body: string }} input
 * @returns {string}
 */
export function formatFetchedDocument({ url, status, finalUrl, body }) {
  const requested = String(url || "");
  const landed = String(finalUrl || requested);
  if (!fetchHostAllowed(requested) || !fetchHostAllowed(landed)) {
    return `ERROR: redirect left the weekly research allowlist: ${landed || requested}`;
  }
  return `HTTP ${status} ${requested}\n${extractFetchedDocText(body)}`;
}

export function buildMaintainPrompt(mode, extras = {}) {
  const model = extras.model || DEFAULT_SCHEDULED_GROK_MODEL;
  const budget = toolBudgetForMode(mode);
  if (mode === "weekly") {
    return [
      "You are the weekly Shiba Studio product-and-automation agent.",
      `Use model ${model}. Work only on the ${TARGET_BRANCH} branch. Never push or merge to main.`,
      "This run has two jobs, in order:",
      "1) Assess the latest relevant capabilities in Claude, ChatGPT/Codex, Grok, and Cursor.",
      "   Fetch current docs with fetch_url (allowlisted hosts only). Compare against IDEAS.md, TODO.md, and the shipped lib/ surfaces.",
      "   Implement at most one bounded increment that belongs in Shiba Studio (Grok/xAI + local-first; do not add a multi-provider catalog).",
      "2) Look for ways to improve this scheduled automation (scripts/ci/scheduled-maintain*.mjs) and apply a small, safe improvement if one is clearly justified. Do not edit .github/workflows/ — GITHUB_TOKEN cannot push workflow files.",
      "If nothing belongs this week, call done with fixed=false and a one-line reason. Do not invent work.",
      "Keep the Windows and macOS native desktop apps (apps/) double-clickable, bundled, auto-updating, and listed on the public packages page; fix app sources, the packer, or site/packages.html when they drift. Do not edit .github/workflows/ — GITHUB_TOKEN cannot push workflow files.",
      "Never weaken proxy.ts or lib/terminal-server.ts origin checks, never delete tests, never disable CI OK.",
      `Budget: at most ${budget.maxSteps} tool calls.`,
    ].join("\n");
  }
  return [
    "You are the daily Shiba Studio vulnerability-remediation agent.",
    `Use model ${model}. Work only on the ${TARGET_BRANCH} branch. Never push or merge to main.`,
    "Remediate high/critical dependency and lockfile vulnerabilities.",
    "Start with run_check \"audit\". If clean, call done with fixed=false and say the tree is already clean.",
    "Playbook: audit_fix first; remaining high/critical advisories get minimal package.json overrides plus run_check \"npm_install\", then re-run audit.",
    "Do not add features. Do not edit .github/ or scripts/ci/. Do not weaken security checks.",
    `Budget: at most ${budget.maxSteps} tool calls.`,
  ].join("\n");
}

export function formatValidateMessage({ mode, model, skip }) {
  if (skip) return SKIP_NO_KEY_MESSAGE;
  return `scheduled-maintain: validate mode=${mode} model=${model} target=${TARGET_BRANCH}`;
}

/**
 * @param {string} cwd
 * @returns {string}
 */
export function gitPorcelain(cwd) {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  return String(res.stdout || "").trim();
}

function porcelainPaths(cwd) {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  // Do not trim the whole buffer — a leading space is the unstaged column
  // of the first path (` M file`).
  return String(res.stdout || "").split("\n").map((line) => {
    if (line.length < 4) return "";
    const rest = line.slice(3);
    if (rest.includes(" -> ")) return rest.split(" -> ").pop();
    return rest.replace(/^"+|"+$/g, "");
  }).filter(Boolean);
}

/**
 * Drop uncommitted workflow-file edits. GITHUB_TOKEN cannot push them, and
 * leaving them dirty fails the later `git push` for the whole job.
 * @param {string} [cwd]
 * @returns {{ reverted: boolean, paths: string[] }}
 */
export function revertGithubWorkflowChanges(cwd = process.cwd()) {
  const paths = porcelainPaths(cwd).filter(isGithubWorkflowPath);
  if (!paths.length) return { reverted: false, paths: [] };
  spawnSync("git", ["checkout", "--", ".github/workflows"], { cwd, encoding: "utf8" });
  spawnSync("git", ["clean", "-fd", "--", ".github/workflows"], { cwd, encoding: "utf8" });
  return { reverted: true, paths };
}

/**
 * Drop every uncommitted edit/untracked file so a discarded Grok run cannot
 * be scooped up by the workflow's `git add -A`.
 * @param {string} cwd
 */
export function discardUncommittedWork(cwd) {
  spawnSync("git", ["reset", "--hard"], { cwd, encoding: "utf8" });
  spawnSync("git", ["clean", "-fd"], { cwd, encoding: "utf8" });
}

/**
 * Last step of a scheduled run. When Grok calls done(fixed=false), any dirty
 * tree is discarded so grok-maintain.yml will not commit exploratory edits.
 * @param {{ fixed: boolean, cwd?: string }} input
 * @returns {{ discarded: boolean, dirty: string, revertedWorkflows: boolean }}
 */
export function finalizeMaintainRun({ fixed, cwd = process.cwd() }) {
  const workflowRevert = revertGithubWorkflowChanges(cwd);
  const before = gitPorcelain(cwd);
  if (fixed) {
    return {
      discarded: false,
      dirty: before,
      revertedWorkflows: workflowRevert.reverted,
    };
  }
  if (before) discardUncommittedWork(cwd);
  return {
    discarded: Boolean(before),
    dirty: gitPorcelain(cwd),
    revertedWorkflows: workflowRevert.reverted,
  };
}
