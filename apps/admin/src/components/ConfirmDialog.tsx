// Phase 16 — confirmation gate for destructive admin actions.
//
// Destructive actions (role changes, verify toggles, deletes) require
// explicit confirmation: a modal with a clear consequence description and
// a dedicated confirm button. Cancel, Escape, and backdrop clicks never fire
// the action. There are no multi-select destructive actions anywhere.
//
// Two usage styles:
// 1. `const { confirm, dialog } = useConfirm();` then
//    `if (await confirm({ title, message, confirmLabel })) { ... }`
//    and render `{dialog}` once per page.
// 2. Direct `<ConfirmDialog ... />` with controlled open/onConfirm/onCancel.

import { useCallback, useEffect, useRef, useState } from 'react';

export interface ConfirmRequest {
  title: string;
  /** Clear, specific consequence text, e.g. what will be changed/deleted. */
  message: string;
  /** Label of the confirm button, e.g. "Delete album". */
  confirmLabel?: string;
  /** Label of the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
}

interface DialogState extends ConfirmRequest {
  resolve: (confirmed: boolean) => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmRequest & {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactNode {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onClick={onCancel}
      data-testid="confirm-dialog-backdrop"
    >
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-dialog-title">{title}</h2>
        <p id="confirm-dialog-message">{message}</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useConfirm(): {
  /** Resolves true only when the user explicitly confirms. */
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  /** Render once per page, typically near the root element. */
  dialog: React.ReactNode;
} {
  const [state, setState] = useState<DialogState | null>(null);
  const stateRef = useRef<DialogState | null>(null);
  stateRef.current = state;

  const confirm = useCallback((request: ConfirmRequest) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...request, resolve });
    });
  }, []);

  const close = useCallback((confirmed: boolean) => {
    const current = stateRef.current;
    setState(null);
    current?.resolve(confirmed);
  }, []);

  const dialog = state ? (
    <ConfirmDialog
      open
      title={state.title}
      message={state.message}
      confirmLabel={state.confirmLabel}
      cancelLabel={state.cancelLabel}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  ) : null;

  return { confirm, dialog };
}
