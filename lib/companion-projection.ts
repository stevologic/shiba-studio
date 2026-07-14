// Deliberately lossy companion projections. Never return workspace roots,
// commands, evidence bodies/metadata, integration data, or task result text.

import { companionActionDigest } from './companion-auth';
import { getDb } from './db';
import { getTask, listAttention, listTasks } from './task-ledger';
import { getPendingApproval } from './tool-approval';
import { listRoutines } from './routines';
import type { AttentionItem, TaskRecord } from './task-types';

const SECRET_KEY = /(authorization|api[-_ ]?key|secret|token|password|cookie|credential|private[-_ ]?key|content|body)/i;
const SECRET_VALUE = /(Bearer\s+[A-Za-z0-9._~+\/-]{8,}|(?:sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{8,}|(?:api[-_ ]?key|secret|token|password)\s*[:=]\s*\S+)/gi;

export function companionSafeText(value: unknown, max = 240): string {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(SECRET_VALUE, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function safeApprovalValue(value: unknown, key = '', depth = 0): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]';
  if (depth > 3) return '[omitted]';
  if (typeof value === 'string') return companionSafeText(value, 160);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => safeApprovalValue(item, key, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 20)
      .map(([childKey, child]) => [childKey, safeApprovalValue(child, childKey, depth + 1)]));
  }
  return '[omitted]';
}

export interface CompanionApprovalDescriptor {
  attentionId: string;
  taskId: string;
  taskVersion: number;
  approvalId: string;
  toolName: string;
  arguments: unknown;
  actionDigest: string;
  expiresAt: string;
}

export function companionApprovalDescriptor(
  attention: AttentionItem,
  task: TaskRecord,
): CompanionApprovalDescriptor | null {
  if (attention.kind !== 'approval' || attention.status !== 'open' || task.status !== 'waiting_for_approval') return null;
  const approvalId = typeof attention.action.approvalId === 'string' ? attention.action.approvalId : '';
  if (!approvalId) return null;
  const pending = getPendingApproval(approvalId);
  if (!pending || pending.runId !== task.runId) return null;
  if (attention.dedupeKey !== `tool-approval:${approvalId}` || attention.action.taskId !== task.id) return null;
  const actionTool = String(attention.action.toolName || '');
  if (pending.toolName !== actionTool) return null;
  if (companionActionDigest(pending.args) !== companionActionDigest(attention.action.args)) return null;
  const requestedExpiry = Date.parse(String(attention.action.expiresAt || ''));
  const pendingExpiry = Date.parse(pending.expiresAt);
  const hardExpiry = Date.parse(attention.createdAt) + 5 * 60_000;
  const expiresAtMs = Math.min(
    Number.isFinite(requestedExpiry) ? requestedExpiry : hardExpiry,
    Number.isFinite(pendingExpiry) ? pendingExpiry : hardExpiry,
    hardExpiry,
  );
  if (expiresAtMs <= Date.now()) return null;
  const exact = {
    attentionId: attention.id,
    taskId: task.id,
    taskVersion: task.version,
    approvalId,
    toolName: pending.toolName,
    args: pending.args,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
  return {
    attentionId: attention.id,
    taskId: task.id,
    taskVersion: task.version,
    approvalId,
    toolName: pending.toolName,
    arguments: safeApprovalValue(pending.args),
    actionDigest: companionActionDigest(exact),
    expiresAt: exact.expiresAt,
  };
}

export function findCompanionApproval(attentionId: string): {
  attention: AttentionItem;
  task: TaskRecord;
  descriptor: CompanionApprovalDescriptor;
} | null {
  const attention = listAttention({ limit: 500 }).items.find((item) => item.id === attentionId);
  if (!attention) return null;
  const task = getTask(attention.taskId);
  if (!task) return null;
  const descriptor = companionApprovalDescriptor(attention, task);
  return descriptor ? { attention, task, descriptor } : null;
}

interface CompanionEvidenceRow {
  id: string;
  taskId: string;
  kind: string;
  status: string;
  label: string;
  scope: string | null;
  recordedAt: string;
}

function taskSummary(task: TaskRecord, evidence: CompanionEvidenceRow[]) {
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    title: companionSafeText(task.title, 160),
    progress: task.progress,
    ...(task.currentStep ? { currentStep: companionSafeText(task.currentStep, 180) } : {}),
    ...(task.nextAction ? { nextAction: companionSafeText(task.nextAction, 180) } : {}),
    version: task.version,
    updatedAt: task.updatedAt,
    evidence: evidence.map((item) => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      label: companionSafeText(item.label, 120),
      ...(item.scope ? { scope: companionSafeText(item.scope, 100) } : {}),
      recordedAt: item.recordedAt,
    })),
  };
}

export function companionTaskSummaries(limit = 30) {
  const tasks = listTasks({ limit: Math.min(50, Math.max(1, limit)) }).tasks;
  if (!tasks.length) return [];
  const placeholders = tasks.map(() => '?').join(', ');
  const rows = getDb().prepare(`
    SELECT id, taskId, kind, status, label, scope, recordedAt
    FROM task_evidence WHERE taskId IN (${placeholders})
    ORDER BY recordedAt DESC
  `).all(...tasks.map((task) => task.id)) as unknown as CompanionEvidenceRow[];
  const evidenceByTask = new Map<string, CompanionEvidenceRow[]>();
  for (const row of rows) {
    const evidence = evidenceByTask.get(row.taskId) || [];
    if (evidence.length < 8) evidence.push(row);
    evidenceByTask.set(row.taskId, evidence);
  }
  return tasks.map((task) => taskSummary(task, evidenceByTask.get(task.id) || []));
}

export function companionAttentionSummaries(limit = 50) {
  return listAttention({ limit: Math.min(100, Math.max(1, limit)) }).items.flatMap((item) => {
    const task = getTask(item.taskId);
    const approval = task ? companionApprovalDescriptor(item, task) : null;
    if (!approval) return [];
    return [{
      id: item.id,
      taskId: item.taskId,
      kind: item.kind,
      status: item.status,
      severity: item.severity,
      title: companionSafeText(item.title, 180),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      approval,
    }];
  });
}

export function companionRoutineSummaries() {
  return listRoutines({ limit: 100 }).routines.map((routine) => ({
    routineId: routine.id,
    name: companionSafeText(routine.name, 160),
    enabled: routine.enabled,
    circuitState: routine.circuitState,
    version: routine.version,
  }));
}
