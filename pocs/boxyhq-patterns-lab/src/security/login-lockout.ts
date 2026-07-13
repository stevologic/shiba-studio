/**
 * Account lockout after failed credential attempts.
 * BoxyHQ-style: MAX_LOGIN_ATTEMPTS + lock window.
 */

export interface LockoutOptions {
  maxAttempts: number;
  lockDurationMs: number;
  now?: () => number;
}

export interface LoginAttemptState {
  email: string;
  failedCount: number;
  lockedUntil: number | null;
}

export class LoginLockout {
  private readonly store = new Map<string, LoginAttemptState>();
  private readonly maxAttempts: number;
  private readonly lockDurationMs: number;
  private readonly now: () => number;

  constructor(opts: Partial<LockoutOptions> = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.lockDurationMs = opts.lockDurationMs ?? 15 * 60 * 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  private key(email: string): string {
    return email.trim().toLowerCase();
  }

  private getOrCreate(email: string): LoginAttemptState {
    const k = this.key(email);
    let state = this.store.get(k);
    if (!state) {
      state = { email: k, failedCount: 0, lockedUntil: null };
      this.store.set(k, state);
    }
    // Auto-unlock when window expires.
    if (state.lockedUntil !== null && this.now() >= state.lockedUntil) {
      state.failedCount = 0;
      state.lockedUntil = null;
    }
    return state;
  }

  isLocked(email: string): boolean {
    const state = this.getOrCreate(email);
    return state.lockedUntil !== null && this.now() < state.lockedUntil;
  }

  remainingLockMs(email: string): number {
    const state = this.getOrCreate(email);
    if (state.lockedUntil === null) return 0;
    return Math.max(0, state.lockedUntil - this.now());
  }

  /** Call after a successful password/magic-link check. */
  recordSuccess(email: string): void {
    const k = this.key(email);
    this.store.set(k, { email: k, failedCount: 0, lockedUntil: null });
  }

  /**
   * Call after a failed credential check.
   * Returns true if the account is now locked.
   */
  recordFailure(email: string): boolean {
    const state = this.getOrCreate(email);
    if (state.lockedUntil !== null && this.now() < state.lockedUntil) {
      return true;
    }
    state.failedCount += 1;
    if (state.failedCount >= this.maxAttempts) {
      state.lockedUntil = this.now() + this.lockDurationMs;
      return true;
    }
    return false;
  }

  snapshot(email: string): LoginAttemptState {
    return { ...this.getOrCreate(email) };
  }
}
