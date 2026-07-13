import { audit } from '@/lib/audit-log';
import {
  beginCompanionAction,
  authenticateCompanion,
  CompanionAuthError,
  finishCompanionAction,
} from '@/lib/companion-auth';
import { findCompanionApproval } from '@/lib/companion-projection';
import {
  applyTaskCommand,
  enqueueTaskCommand,
  getTask,
  listAttention,
  resolveAttention,
} from '@/lib/task-ledger';
import { getRoutine, triggerRoutineManually } from '@/lib/routines';
import type { CompanionScope } from '@/lib/companion-auth';

type ActionKind = 'approve' | 'deny' | 'steer' | 'cancel' | 'resolve_attention' | 'start_routine';

const ACTION_SCOPE: Record<ActionKind, CompanionScope> = {
  approve: 'action:attention',
  deny: 'action:attention',
  steer: 'action:steer',
  cancel: 'action:cancel',
  resolve_attention: 'action:attention',
  start_routine: 'action:routines',
};

function actionKind(value: unknown): ActionKind {
  const kind = String(value || '') as ActionKind;
  if (!(kind in ACTION_SCOPE)) throw new CompanionAuthError('Unknown companion action', 400);
  return kind;
}

function replayResponse(receipt: ReturnType<typeof beginCompanionAction>) {
  if (receipt.state === 'pending') {
    throw new CompanionAuthError('This action is already being processed; its outcome is not safe to repeat', 409);
  }
  if (receipt.state !== 'replay') return null;
  const failed = receipt.result?.ok === false;
  return Response.json({ ok: !failed, replay: true, ...receipt.result }, { status: failed ? 409 : 200 });
}

export async function POST(request: Request) {
  let receiptId: string | null = null;
  let auth: Awaited<ReturnType<typeof authenticateCompanion>> | null = null;
  let kind: ActionKind | null = null;
  try {
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 16 * 1024) throw new CompanionAuthError('Companion action body is too large', 413);
    auth = await authenticateCompanion(request);
    const body = await request.json();
    kind = actionKind(body.action);
    if (!auth.scopes.has(ACTION_SCOPE[kind])) {
      throw new CompanionAuthError(`Companion device lacks ${ACTION_SCOPE[kind]} permission`, 403);
    }
    const targetId = kind === 'start_routine'
      ? String(body.routineId || '')
      : String(body.taskId || body.attentionId || '');
    const receipt = beginCompanionAction({
      deviceId: auth.device.id,
      idempotencyKey: body.idempotencyKey,
      kind,
      targetId,
      request: body,
    });
    const replay = replayResponse(receipt);
    if (replay) return replay;
    receiptId = receipt.id;

    let result: Record<string, unknown>;
    if (kind === 'approve' || kind === 'deny') {
      const exact = findCompanionApproval(String(body.attentionId || ''));
      if (!exact) throw new CompanionAuthError('Approval is no longer pending', 409);
      if (Date.parse(exact.descriptor.expiresAt) <= Date.now()) throw new CompanionAuthError('Approval has expired', 409);
      if (
        Number(body.expectedVersion) !== exact.descriptor.taskVersion
        || body.actionDigest !== exact.descriptor.actionDigest
        || body.expiresAt !== exact.descriptor.expiresAt
        || body.taskId !== exact.task.id
      ) {
        throw new CompanionAuthError('Approval action or task revision changed; refresh before deciding', 409);
      }
      const command = enqueueTaskCommand({
        taskId: exact.task.id,
        kind,
        payload: {
          approvalId: exact.descriptor.approvalId,
          actionDigest: exact.descriptor.actionDigest,
          expiresAt: exact.descriptor.expiresAt,
          companionDeviceId: auth.device.id,
        },
        idempotencyKey: `companion:${auth.device.id}:${String(body.idempotencyKey)}`,
        expectedVersion: exact.descriptor.taskVersion,
      });
      const applied = applyTaskCommand(command.id);
      if (applied.status !== 'applied') throw new CompanionAuthError('Approval could not be applied', 409);
      resolveAttention(exact.attention.id, 'resolved');
      result = { action: kind, taskId: exact.task.id, attentionId: exact.attention.id };
    } else if (kind === 'steer') {
      const task = getTask(String(body.taskId || ''));
      if (!task) throw new CompanionAuthError('Task not found', 404);
      const instruction = String(body.instruction || '').trim();
      if (!instruction || instruction.length > 8_000) throw new CompanionAuthError('Steering instruction is required and must be at most 8,000 characters', 400);
      if (Number(body.expectedVersion) !== task.version) throw new CompanionAuthError('Task revision changed; refresh before steering', 409);
      const command = enqueueTaskCommand({
        taskId: task.id,
        kind: 'steer',
        payload: { instruction, companionDeviceId: auth.device.id },
        idempotencyKey: `companion:${auth.device.id}:${String(body.idempotencyKey)}`,
        expectedVersion: task.version,
      });
      const applied = applyTaskCommand(command.id);
      if (applied.status !== 'applied') throw new CompanionAuthError('Steering could not be applied', 409);
      result = { action: kind, taskId: task.id };
    } else if (kind === 'cancel') {
      const task = getTask(String(body.taskId || ''));
      if (!task) throw new CompanionAuthError('Task not found', 404);
      if (Number(body.expectedVersion) !== task.version) throw new CompanionAuthError('Task revision changed; refresh before cancelling', 409);
      const command = enqueueTaskCommand({
        taskId: task.id,
        kind: 'cancel',
        payload: { companionDeviceId: auth.device.id },
        idempotencyKey: `companion:${auth.device.id}:${String(body.idempotencyKey)}`,
        expectedVersion: task.version,
      });
      const applied = applyTaskCommand(command.id);
      if (applied.status !== 'applied') throw new CompanionAuthError('Cancellation could not be applied', 409);
      result = { action: kind, taskId: task.id };
    } else if (kind === 'resolve_attention') {
      const attention = listAttention({ status: 'open', limit: 500 }).items
        .find((item) => item.id === String(body.attentionId || ''));
      if (!attention) throw new CompanionAuthError('Attention item is no longer open', 409);
      if (attention.kind === 'approval') {
        throw new CompanionAuthError('Approval items must be approved or denied through their exact bound action', 409);
      }
      if (body.updatedAt !== attention.updatedAt) throw new CompanionAuthError('Attention item changed; refresh before resolving', 409);
      resolveAttention(attention.id, 'resolved');
      result = { action: kind, attentionId: attention.id, taskId: attention.taskId };
    } else {
      const routineId = String(body.routineId || '').trim();
      const routine = getRoutine(routineId);
      if (!routine) throw new CompanionAuthError('Saved routine not found', 404);
      if (!routine.enabled) throw new CompanionAuthError('Routine is disabled', 409);
      if (routine.circuitState === 'open') throw new CompanionAuthError('Routine circuit breaker is open', 409);
      if (Number(body.expectedVersion) !== routine.version) {
        throw new CompanionAuthError('Routine revision changed; refresh before starting it', 409);
      }
      const queued = triggerRoutineManually(
        routine.id,
        {},
        `companion:${auth.device.id}:${String(body.idempotencyKey)}`,
      );
      result = {
        action: kind,
        routineId: routine.id,
        routineVersion: routine.version,
        invocationId: queued.invocation.id,
        accepted: true,
      };
    }

    finishCompanionAction(receiptId!, result);
    audit('auth', `companion ${kind}`, undefined, {
      deviceId: auth.device.id,
      deviceName: auth.device.name,
      targetId,
      taskVersion: body.expectedVersion,
      actionDigest: body.actionDigest,
      instructionLength: kind === 'steer' ? String(body.instruction || '').length : undefined,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Companion action failed';
    if (receiptId) {
      try { finishCompanionAction(receiptId, { ok: false, error: message }, false); } catch { /* receipt already finished */ }
    }
    if (auth && kind) {
      audit('auth', `companion ${kind} rejected`, message, { deviceId: auth.device.id, deviceName: auth.device.name });
    }
    const status = error instanceof CompanionAuthError ? error.status : 400;
    return Response.json({ ok: false, error: message }, { status });
  }
}
