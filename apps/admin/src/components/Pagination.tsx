// Phase 16 — pagination controls driven by the backend PageInfo envelope.

import type { PageInfo } from '../api/types';

export function Pagination({
  pagination,
  onPage,
}: {
  pagination: PageInfo;
  onPage: (page: number) => void;
}): React.ReactNode {
  const { page, totalPages, total, limit } = pagination;
  if (totalPages <= 1 && total === 0) return null;
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="muted" aria-live="polite">
        {from}–{to} of {total}
      </span>
      <div className="pagination-buttons">
        <button
          type="button"
          className="btn btn-sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >
          ← Prev
        </button>
        <span className="muted">
          Page {page} of {totalPages}
        </span>
        <button
          type="button"
          className="btn btn-sm"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >
          Next →
        </button>
      </div>
    </nav>
  );
}
