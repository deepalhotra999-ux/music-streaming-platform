// Phase 16 — shared async data-state primitives so every page has
// consistent loading / empty / error-with-retry states.

import { apiErrorMessage } from '../api/client';

export function LoadingState({ label = 'Loading…' }: { label?: string }): React.ReactNode {
  return (
    <div className="state-block" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({ message }: { message: string }): React.ReactNode {
  return (
    <div className="state-block">
      <p className="muted">{message}</p>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): React.ReactNode {
  return (
    <div className="state-block" role="alert">
      <p className="error-text">{apiErrorMessage(error)}</p>
      <button type="button" className="btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
