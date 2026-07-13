import { evaluateTaskCompletion, getTask, transitionTask } from '@/lib/task-ledger';

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const completion = evaluateTaskCompletion(id, true);
    let task = getTask(id);
    if (completion.complete && task && ['waiting_for_approval', 'blocked'].includes(task.status)) {
      task = transitionTask({
        taskId: id,
        status: 'succeeded',
        expectedVersion: task.version,
        result: task.result || 'Completion contract verified.',
        currentStep: 'Completion contract verified',
        nextAction: null,
      });
    }
    return Response.json({ ok: true, completion, task });
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : 'Verification failed' }, { status: 400 });
  }
}
