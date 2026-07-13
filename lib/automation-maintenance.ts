interface AutomationMaintenanceGlobals {
  __shibaAutomationMaintenance?: { token: symbol; reason: string };
}

const globals = globalThis as unknown as AutomationMaintenanceGlobals;

/** True while a control-plane operation (currently backup restore) has fenced
 * new automation/background dispatch in this process. */
export function isAutomationMaintenanceActive(): boolean {
  return Boolean(globals.__shibaAutomationMaintenance);
}

export function automationMaintenanceReason(): string | null {
  return globals.__shibaAutomationMaintenance?.reason ?? null;
}

/** Acquire the process-wide automation fence. The returned release callback
 * is token-fenced and idempotent so an old cleanup cannot release a newer
 * maintenance operation. */
export function beginAutomationMaintenance(reason: string): () => void {
  if (globals.__shibaAutomationMaintenance) {
    throw new Error(`Automation maintenance is already in progress: ${globals.__shibaAutomationMaintenance.reason}`);
  }
  const token = Symbol('automation-maintenance');
  globals.__shibaAutomationMaintenance = { token, reason };
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (globals.__shibaAutomationMaintenance?.token === token) {
      globals.__shibaAutomationMaintenance = undefined;
    }
  };
}

