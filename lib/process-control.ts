import { execFile, type ChildProcess } from 'child_process';

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function hasClosedIo(child: ChildProcess): boolean {
  return [child.stdin, child.stdout, child.stderr].every((stream) => (
    !stream || stream.destroyed || ('closed' in stream && stream.closed === true)
  ));
}

function hasClosed(child: ChildProcess): boolean {
  return hasExited(child) && hasClosedIo(child);
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasClosed(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(hasClosed(child)), timeoutMs);
    timer.unref?.();
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      child.removeListener('close', onClose);
      resolve(closed);
    };
    child.once('close', onClose);
    if (hasClosed(child)) finish(true);
  });
}

function taskkillTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM still proves the group exists; ESRCH means every member is gone.
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return true;
}

/** Terminate a spawned command and its descendants, wait for close, and
 * escalate after a short grace period. Windows uses taskkill /T; POSIX callers
 * should spawn detached so the negative PID addresses the whole process group. */
export async function terminateProcessTree(child: ChildProcess, graceMs = 1_000): Promise<void> {
  const pid = child.pid;
  if (!pid || hasClosed(child)) return;

  if (process.platform === 'win32') {
    if (!(await taskkillTree(pid))) child.kill('SIGTERM');
    if (await waitForClose(child, graceMs)) return;
    // Node maps this to forceful TerminateProcess on Windows. taskkill may be
    // unavailable in a restricted host, so keep the direct fallback.
    child.kill('SIGKILL');
    await waitForClose(child, 500);
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  // Parent close is not enough: a descendant may trap TERM while keeping the
  // detached process group alive. Probe the group itself before deciding the
  // graceful stop succeeded.
  if (await waitForProcessGroupExit(pid, graceMs)) {
    await waitForClose(child, 250);
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
  await Promise.all([
    waitForProcessGroupExit(pid, 500),
    waitForClose(child, 500),
  ]);
}
