'use client';

/**
 * Studio toast surface — success is silent (UI already reflects the change).
 * Errors and warnings still pop so failures stay visible.
 *
 * Also monkey-patches sonner's toast.success so any leftover direct imports
 * cannot show green success modals.
 */
import { toast as sonnerToast } from 'sonner';

// No params — structurally compatible with sonner's success(message, data).
function silentSuccess(): string | number {
  return '';
}

// Patch sonner itself so success never surfaces, even if something imports
// `toast` from 'sonner' instead of this module.
try {
  (sonnerToast as unknown as { success: () => string | number }).success = silentSuccess;
} catch {
  /* immutable in some bundlers — wrapper below still covers @/lib/toast imports */
}

export const toast = Object.assign(
  (message: Parameters<typeof sonnerToast>[0], data?: Parameters<typeof sonnerToast>[1]) =>
    sonnerToast(message, data),
  {
    success: silentSuccess as typeof sonnerToast.success,
    error: sonnerToast.error.bind(sonnerToast),
    warning: sonnerToast.warning.bind(sonnerToast),
    info: sonnerToast.info.bind(sonnerToast),
    message: sonnerToast.message.bind(sonnerToast),
    loading: sonnerToast.loading.bind(sonnerToast),
    dismiss: sonnerToast.dismiss.bind(sonnerToast),
    promise: sonnerToast.promise.bind(sonnerToast),
    custom: sonnerToast.custom.bind(sonnerToast),
  },
);

export { Toaster } from 'sonner';
