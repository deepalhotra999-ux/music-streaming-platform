// Admin V2 — reason-gated confirmation dialog.
//
// Sensitive admin actions (bans, suspensions, emergency toggles, bulk status
// changes) require a written reason. This dialog combines the Phase 16
// ConfirmDialog UX (modal, Escape-to-close, focus trap) with a mandatory
// reason textarea: the confirm button stays disabled until the reason meets
// the minimum length. The server re-validates the reason independently.

import { useEffect, useRef, useState } from 'react';

export interface ReasonRequest {
  title: string;
  /** Clear, specific consequence text. */
  message: string;
  /** Placeholder for the reason textarea. */
  reasonPlaceholder?: string;
  /** Minimum reason length. Defaults to 10. */
  minReasonLength?: number;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function ReasonDialog({
  open,
  title,
  message,
  reasonPlaceholder = 'Reason (required)…',
  minReasonLength = 10,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ReasonRequest & {
  open: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}): React.ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCancel();
        return;
      }
      if (event.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const items = Array.from(focusables).filter((el) => !el.hasAttribute('disabled'));
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>('[data-dialog-cancel]')?.focus();
    return () => {
      previouslyFocused.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const trimmed = reason.trim();
  const valid = trimmed.length >= minReasonLength;

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onClick={onCancel}
      data-testid="reason-dialog-backdrop"
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="reason-dialog-title"
        aria-describedby="reason-dialog-message"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="reason-dialog-title">{title}</h2>
        <p id="reason-dialog-message">{message}</p>
        <div className="field">
          <label htmlFor="reason-dialog-reason">
            Reason <span className="muted">(min {minReasonLength} characters)</span>
          </label>
          <textarea
            id="reason-dialog-reason"
            rows={3}
            placeholder={reasonPlaceholder}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            aria-invalid={!valid}
          />
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel} data-dialog-cancel>
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!valid}
            onClick={() => onConfirm(trimmed)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Promise-style hook: `const reason = await askReason({...})` resolves with
 * the reason string, or null when cancelled.
 */
export function useReason(): {
  askReason: (request: ReasonRequest) => Promise<string | null>;
  dialog: React.ReactNode;
} {
  const [state, setState] = useState<
    (ReasonRequest & { resolve: (reason: string | null) => void }) | null
  >(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const askReason = (request: ReasonRequest): Promise<string | null> =>
    new Promise<string | null>((resolve) => {
      setState({ ...request, resolve });
    });

  const close = (reason: string | null): void => {
    const current = stateRef.current;
    setState(null);
    current?.resolve(reason);
  };

  const dialog = state ? (
    <ReasonDialog
      open
      title={state.title}
      message={state.message}
      reasonPlaceholder={state.reasonPlaceholder}
      minReasonLength={state.minReasonLength}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      onConfirm={(reason) => close(reason)}
      onCancel={() => close(null)}
    />
  ) : null;

  return { askReason, dialog };
}
