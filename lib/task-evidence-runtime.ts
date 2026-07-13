import path from 'node:path';
import { getTask, recordTaskEvidence } from './task-ledger';
import type { CompletionRequirement, EvidenceKind, EvidenceStatus } from './task-types';

function resultObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function commandKind(command: string): EvidenceKind {
  if (/\b(playwright|cypress|vitest|jest|pytest|cargo\s+test|go\s+test|npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+test)\b/i.test(command)) return 'test';
  if (/\b(build|tsc|typecheck|lint|eslint|cargo\s+check|go\s+vet)\b/i.test(command)) return 'build';
  if (/\bgit\s+(diff|status|show)\b/i.test(command)) return 'diff';
  if (/\b(vercel|netlify|deploy)\b/i.test(command)) return 'deployment';
  return 'command';
}

function requirementMatches(requirement: CompletionRequirement, kind: EvidenceKind, command: string): boolean {
  if (requirement.acceptedKinds?.length) return requirement.acceptedKinds.includes(kind);
  const description = `${requirement.label} ${requirement.description || ''}`.toLowerCase();
  if (kind === 'test') return /\b(test|spec|e2e|integration|unit)\b/.test(description);
  if (kind === 'build') return /\b(build|typecheck|type check|lint|compile)\b/.test(description);
  if (kind === 'diff') return /\b(diff|changes?|git)\b/.test(description);
  if (kind === 'deployment') return /\b(deploy|production|preview|url)\b/.test(description);
  return description.includes(command.trim().toLowerCase());
}

function commandResult(value: unknown): { status: EvidenceStatus; exitCode?: number; summary: string } {
  const result = resultObject(value);
  const numeric = result.code == null ? undefined : Number(result.code);
  const failed = Number.isFinite(numeric)
    ? numeric !== 0
    : result.ok === false || typeof result.error === 'string';
  const output = String(result.stdout || result.output || result.stderr || result.error || JSON.stringify(value)).slice(0, 8_000);
  return {
    status: failed ? 'failed' : 'passed',
    ...(Number.isFinite(numeric) ? { exitCode: numeric } : {}),
    summary: output || (failed ? 'Command failed.' : 'Command completed successfully.'),
  };
}

/** Convert trustworthy tool results into typed task evidence. Never infers success from model prose. */
export async function recordRuntimeToolEvidence(input: {
  taskId: string;
  runId: string;
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  screenshot?: string;
  workspacePath?: string;
}): Promise<void> {
  const task = getTask(input.taskId);
  if (!task) return;
  const scope = task.workspaceRoots.length === 1 ? task.workspaceRoots[0].id : undefined;
  const metadata = { runId: input.runId, toolName: input.toolName };

  if (input.toolName === 'shell_exec' || input.toolName === 'terminal_exec' || input.toolName === 'sandbox_exec') {
    const command = String(input.args.command || '').trim();
    if (!command) return;
    const kind = commandKind(command);
    const outcome = commandResult(input.result);
    recordTaskEvidence({
      taskId: task.id,
      kind,
      status: outcome.status,
      label: command.slice(0, 300),
      summary: outcome.summary,
      command,
      exitCode: outcome.exitCode,
      scope,
      metadata,
    });
    for (const requirement of task.contract?.requirements || []) {
      if (!requirementMatches(requirement, kind, command)) continue;
      recordTaskEvidence({
        taskId: task.id,
        requirementId: requirement.id,
        kind,
        status: outcome.status,
        label: requirement.label,
        summary: outcome.summary,
        command,
        exitCode: outcome.exitCode,
        scope,
        metadata,
      });
    }
  }

  if (input.toolName === 'fs_write' && typeof input.args.path === 'string') {
    const artifactPath = input.args.path.trim();
    if (!artifactPath) return;
    const absolute = input.workspacePath ? path.resolve(input.workspacePath, artifactPath) : artifactPath;
    recordTaskEvidence({
      taskId: task.id,
      kind: 'artifact',
      status: 'informational',
      label: `Created ${artifactPath}`,
      summary: `The task wrote ${artifactPath}.`,
      uri: absolute,
      scope,
      metadata: { ...metadata, path: artifactPath, absolutePath: absolute },
    });
    try {
      const { autoRegisterArtifactWrite } = await import('./artifacts');
      await autoRegisterArtifactWrite({ taskId: task.id, filePath: absolute, runId: input.runId });
    } catch {
      // Registration is a projection seam. The successful file write remains
      // valid evidence even if the output is unsupported or changes again.
    }
  }

  if (input.screenshot) {
    recordTaskEvidence({
      taskId: task.id,
      kind: 'screenshot',
      status: 'passed',
      label: `${input.toolName} screenshot`,
      summary: 'A browser screenshot was captured during the run.',
      uri: input.screenshot,
      scope,
      metadata,
    });
  }
}
