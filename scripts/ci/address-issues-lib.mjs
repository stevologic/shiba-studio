/**
 * Testable policy for unattended Grok work on admin- or automation-filed
 * GitHub issues. The workflow and address-issues.mjs both import this file.
 */

import {
  finalizeMaintainRun,
  isGithubWorkflowPath,
  resolveScheduledModel,
  TARGET_BRANCH,
} from "./scheduled-maintain-lib.mjs";

export { TARGET_BRANCH, resolveScheduledModel, finalizeMaintainRun, isGithubWorkflowPath };

export const SKIP_NO_KEY_MESSAGE = "address-issues: skipped (GROK_API_KEY is not set)";
export const ISSUE_LABEL_WORKING = "grok-working";
export const ISSUE_LABEL_ADDRESSED = "grok-addressed";
export const ISSUE_LABEL_FAILED = "grok-failed";
export const ISSUE_LABEL_SKIP = "grok-skip";
export const AUTOMATION_LOGINS = Object.freeze([
  "github-actions[bot]",
  "github-actions",
  "dependabot[bot]",
  "dependabot",
  "renovate[bot]",
  "renovate",
]);
export const ADMIN_ASSOCIATIONS = Object.freeze(["OWNER", "MEMBER", "COLLABORATOR"]);

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

export function isSelectOnly(argv = process.argv.slice(2)) {
  return argv.includes("--select");
}

/**
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 * @returns {number | null}
 */
export function requestedIssueNumber(argv = process.argv.slice(2), env = process.env) {
  const flag = argv.find((arg) => arg.startsWith("--issue="));
  if (flag) {
    const value = Number(flag.slice("--issue=".length));
    return Number.isInteger(value) && value > 0 ? value : null;
  }
  const fromEnv = Number(env.ISSUE_NUMBER || env.GITHUB_ISSUE_NUMBER || 0);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : null;
}

export function issuesFileFromArgv(argv = process.argv.slice(2)) {
  const flag = argv.find((arg) => arg.startsWith("--issues-file="));
  return flag ? flag.slice("--issues-file=".length) : "";
}

function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  return labels.map((label) => {
    if (typeof label === "string") return label.trim().toLowerCase();
    if (label && typeof label === "object") return String(label.name || "").trim().toLowerCase();
    return "";
  }).filter(Boolean);
}

export function normalizeIssue(raw) {
  const issue = raw && typeof raw === "object" ? raw : {};
  const author = issue.author && typeof issue.author === "object" ? issue.author : {};
  const user = issue.user && typeof issue.user === "object" ? issue.user : {};
  const login = String(author.login || user.login || issue.login || issue.user_login || "").trim();
  const type = String(author.type || user.type || issue.type || "").trim();
  const association = String(
    issue.authorAssociation || issue.author_association || issue.association || "",
  ).trim().toUpperCase();
  const number = Number(issue.number);
  return {
    number: Number.isInteger(number) ? number : 0,
    title: String(issue.title || "").trim(),
    body: String(issue.body || ""),
    state: String(issue.state || "").trim().toLowerCase(),
    login,
    type,
    association,
    labels: labelNames(issue.labels),
    createdAt: String(issue.createdAt || issue.created_at || ""),
    htmlUrl: String(issue.html_url || issue.url || ""),
    isPullRequest: Boolean(issue.pull_request || issue.pullRequest),
  };
}

export function isAutomationAuthor(login, type = "") {
  const id = String(login || "").trim().toLowerCase();
  if (!id) return false;
  if (String(type || "").trim().toLowerCase() === "bot") return true;
  if (id.endsWith("[bot]")) return true;
  return AUTOMATION_LOGINS.some((name) => name.toLowerCase() === id);
}

export function isAdminAuthor(login, association = "", adminLogins = []) {
  const assoc = String(association || "").trim().toUpperCase();
  if (ADMIN_ASSOCIATIONS.includes(assoc)) return true;
  const id = String(login || "").trim().toLowerCase();
  if (!id) return false;
  return adminLogins.map((name) => String(name).trim().toLowerCase()).filter(Boolean).includes(id);
}

export function isIssueEligible(raw, opts = {}) {
  const issue = normalizeIssue(raw);
  if (!issue.number || issue.isPullRequest) return false;
  if (issue.state && issue.state !== "open") return false;
  if (issue.labels.includes(ISSUE_LABEL_SKIP) || issue.labels.includes("wontfix")) return false;
  if (issue.labels.includes(ISSUE_LABEL_WORKING) && !opts.ignoreWorking) return false;
  if (issue.labels.includes(ISSUE_LABEL_ADDRESSED) && !opts.allowAddressed) return false;
  const adminLogins = opts.adminLogins || [];
  return isAdminAuthor(issue.login, issue.association, adminLogins)
    || isAutomationAuthor(issue.login, issue.type);
}

export function selectIssueToAddress(rawIssues, opts = {}) {
  const issues = (Array.isArray(rawIssues) ? rawIssues : []).map(normalizeIssue);
  const requested = Number(opts.requestedNumber || 0);
  const eligible = issues
    .filter((issue) => isIssueEligible(issue, {
      ...opts,
      // The workflow claims the issue with grok-working before the agent
      // starts. An explicit --issue=N must still see that claimed issue.
      ignoreWorking: Boolean(opts.ignoreWorking || requested),
    }))
    .filter((issue) => !requested || issue.number === requested)
    .sort((a, b) => {
      const left = a.createdAt || "";
      const right = b.createdAt || "";
      if (left && right && left !== right) return left.localeCompare(right);
      return a.number - b.number;
    });
  return eligible[0] || null;
}

export function issueCommitMarker(issueNumber) {
  return `[grok-issue-#${Number(issueNumber) || 0}]`;
}

export function shouldStopIssueLoop(subjects, issueNumber) {
  const marker = issueCommitMarker(issueNumber);
  let streak = 0;
  for (const subject of subjects || []) {
    if (String(subject || "").includes(marker)) streak += 1;
    else break;
  }
  return streak >= 3;
}

export function writeAllowedForIssue(relPath) {
  const rel = String(relPath || "").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!rel || rel === ".git" || rel.startsWith(".git/")) return false;
  if (rel === "node_modules" || rel.startsWith("node_modules/")) return false;
  if (/(^|\/)package-lock\.json$/.test(rel)) return false;
  // GITHUB_TOKEN cannot create or update workflow files. Run
  // 31644453870 failed the push with "without `workflows` permission"
  // after Grok edited `.github/workflows/ci.yml`.
  if (isGithubWorkflowPath(rel)) return false;
  return true;
}

export function buildIssuePrompt(issue, extras = {}) {
  const model = extras.model || resolveScheduledModel();
  const number = issue?.number || "?";
  return [
    "You are the Shiba Studio issue-addressing agent.",
    `Use model ${model}. Work only on the ${TARGET_BRANCH} branch. Never push or merge to main.`,
    `Address GitHub issue #${number}: ${issue?.title || "(untitled)"}.`,
    "This issue was filed by a repository admin or by an enabled project automation (GitHub Actions, Dependabot, or another bot).",
    "Read the issue body carefully. Implement a real fix in this repository when one belongs here.",
    "If the issue is already resolved on development (for example CI is green after a later heal), call done with fixed=false and close=true.",
    "If the request is out of scope, unsafe, or needs a human, call done with fixed=false and close=false.",
    "Never weaken proxy.ts or lib/terminal-server.ts origin checks, never delete tests, never disable CI OK.",
    "Do not edit .github/workflows/ — GITHUB_TOKEN cannot push workflow files.",
    "Do not invent extra features beyond the issue.",
    `Budget: at most ${extras.maxSteps || 50} tool calls.`,
  ].join("\n");
}

export function formatValidateMessage({ model, skip }) {
  if (skip) return SKIP_NO_KEY_MESSAGE;
  return `address-issues: validate model=${model} target=${TARGET_BRANCH}`;
}

export function formatSelectMessage(issue) {
  if (!issue) return "address-issues: no eligible admin or automation issue";
  return `address-issues: selected #${issue.number} ${issue.title}`.trim();
}
