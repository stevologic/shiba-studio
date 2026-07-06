'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle, HelpCircle } from 'lucide-react';

interface DialogOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  defaultValue?: string;
  placeholder?: string;
}

interface DialogRequest extends DialogOptions {
  kind: 'confirm' | 'prompt';
  resolve: (value: boolean | string | null) => void;
}

let enqueue: ((req: DialogRequest) => void) | null = null;

/** In-app replacement for window.confirm — resolves true/false. Requires <ConfirmHost /> mounted. */
export function confirmDialog(opts: DialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!enqueue) {
      resolve(false);
      return;
    }
    enqueue({ kind: 'confirm', ...opts, resolve: (v) => resolve(v === true) });
  });
}

/** In-app replacement for window.prompt — resolves the string or null when dismissed. */
export function promptDialog(opts: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (!enqueue) {
      resolve(null);
      return;
    }
    enqueue({ kind: 'prompt', ...opts, resolve: (v) => resolve(typeof v === 'string' ? v : null) });
  });
}

export default function ConfirmHost() {
  const [req, setReq] = useState<DialogRequest | null>(null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    enqueue = (next) => {
      setReq((prev) => {
        prev?.resolve(prev.kind === 'confirm' ? false : null);
        return next;
      });
      setValue(next.defaultValue || '');
    };
    return () => {
      enqueue = null;
    };
  }, []);

  useEffect(() => {
    if (req?.kind === 'prompt') {
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 40);
      return () => window.clearTimeout(t);
    }
  }, [req]);

  const dismiss = useCallback(() => {
    setReq((prev) => {
      prev?.resolve(prev.kind === 'confirm' ? false : null);
      return null;
    });
  }, []);

  const submit = useCallback(() => {
    setReq((prev) => {
      if (prev) prev.resolve(prev.kind === 'confirm' ? true : value.trim());
      return null;
    });
  }, [value]);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      } else if (e.key === 'Enter' && req.kind === 'confirm') {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req, dismiss, submit]);

  if (!req) return null;

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-[90] p-4"
      onClick={dismiss}
    >
          <motion.div
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.15 }}
            className="modal w-full max-w-sm p-5"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={req.title}
          >
            <div className="flex items-start gap-3">
              <span className={`confirm-dialog-icon ${req.danger ? 'confirm-dialog-icon-danger' : ''}`}>
                {req.danger ? <AlertTriangle size={18} /> : <HelpCircle size={18} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-[15px]">{req.title}</div>
                {req.message && <div className="text-xs text-muted mt-1.5 leading-relaxed">{req.message}</div>}
              </div>
            </div>

            {req.kind === 'prompt' && (
              <input
                ref={inputRef}
                className="grok-input mt-4"
                value={value}
                placeholder={req.placeholder}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            )}

            <div className="flex gap-2.5 mt-5">
              <button type="button" onClick={dismiss} className="grok-btn grok-btn-secondary flex-1">
                {req.cancelLabel || 'Cancel'}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={req.kind === 'prompt' && !value.trim()}
                className={`grok-btn flex-1 ${req.danger ? 'grok-btn-danger' : 'grok-btn-primary'}`}
              >
                {req.confirmLabel || (req.kind === 'prompt' ? 'Save' : 'Confirm')}
              </button>
            </div>
      </motion.div>
    </div>
  );
}
