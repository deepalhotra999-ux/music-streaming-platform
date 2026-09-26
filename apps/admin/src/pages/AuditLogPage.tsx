// Phase 16 — audit log: READ-ONLY paginated table.
//
// The audit trail is immutable. This page deliberately renders NO
// edit/delete buttons and there are no mutation wrappers in src/api/audit.ts.

import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/PermissionsContext';
import { apiErrorMessage } from '../api/client';
import { listAuditLogs } from '../api/audit';
import type { AuditLogQuery } from '../api/audit';
import type { AuditLog } from '../api/types';
import { reverseAuditLog } from '../api/governance';
import { useApiList } from '../hooks/useApiList';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { Pagination } from '../components/Pagination';
import { useConfirm } from '../components/ConfirmDialog';
import { RequirePermission } from '../components/PermissionGate';
import { formatDate, shortId } from '../utils/format';

const PAGE_SIZE = 25;

export function AuditLogPage(): React.ReactNode {
  return (
    <RequirePermission perm="audit.view">
      <AuditLogContent />
    </RequirePermission>
  );
}

function AuditLogContent(): React.ReactNode {
  const { client } = useAuth();
  const { isSuperAdmin } = usePermissions();
  const [actionInput, setActionInput] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [actorInput, setActorInput] = useState('');
  const [targetTypeInput, setTargetTypeInput] = useState('');
  const [targetIdInput, setTargetIdInput] = useState('');

  const fetcher = useCallback(
    (query: AuditLogQuery) => listAuditLogs(client, { ...query, limit: PAGE_SIZE }),
    [client],
  );
  const list = useApiList(fetcher, { page: 1 } as AuditLogQuery);

  function handleSearch(event: FormEvent): void {
    event.preventDefault();
    list.setQuery({
      action: actionInput.trim() || undefined,
      actorId: actorInput.trim() || undefined,
      targetType: targetTypeInput.trim() || undefined,
      targetId: targetIdInput.trim() || undefined,
    });
  }

  function clearFilters(): void {
    setActionInput('');
    setActorInput('');
    setTargetTypeInput('');
    setTargetIdInput('');
    list.setQuery({
      action: undefined,
      actorId: undefined,
      targetType: undefined,
      targetId: undefined,
    });
  }

  return (
    <div>
      <div className="page-header">
        <h1>Audit Log</h1>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>
        Immutable record of privileged admin actions. Rows cannot be edited or deleted.
        {isSuperAdmin &&
          ' SUPER_ADMIN may reverse reversible rows — a reversal is itself a new audit row; history is never rewritten.'}
      </p>
      {actionError && (
        <div className="form-error" role="alert">
          {actionError}
        </div>
      )}
      {actionOk && (
        <div className="success-banner" role="status">
          {actionOk}
        </div>
      )}

      <form className="toolbar" onSubmit={handleSearch}>
        <div className="field">
          <label htmlFor="audit-action">Action</label>
          <input
            id="audit-action"
            type="search"
            placeholder="e.g. user.role.update"
            value={actionInput}
            onChange={(event) => setActionInput(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="audit-actor">Actor ID</label>
          <input
            id="audit-actor"
            type="search"
            placeholder="Actor user ID"
            value={actorInput}
            onChange={(event) => setActorInput(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="audit-target-type">Target type</label>
          <input
            id="audit-target-type"
            type="search"
            placeholder="e.g. user, artist"
            value={targetTypeInput}
            onChange={(event) => setTargetTypeInput(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="audit-target-id">Target ID</label>
          <input
            id="audit-target-id"
            type="search"
            placeholder="Target ID"
            value={targetIdInput}
            onChange={(event) => setTargetIdInput(event.target.value)}
          />
        </div>
        <button type="submit" className="btn">
          Filter
        </button>
        <button type="button" className="btn" onClick={clearFilters}>
          Clear
        </button>
      </form>

      {list.loading ? (
        <LoadingState label="Loading audit log…" />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data.length === 0 ? (
        <EmptyState message="No audit entries match the current filters." />
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Action</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Target</th>
                  <th scope="col">Reversal</th>
                  <th scope="col">Metadata</th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((row) => (
                  <tr key={row.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{formatDate(row.createdAt)}</td>
                    <td className="mono">{row.action}</td>
                    <td className="mono" title={row.actorId}>
                      {shortId(row.actorId)}
                    </td>
                    <td className="mono" title={row.targetId ?? ''}>
                      {row.targetType}
                      {row.targetId ? ` · ${shortId(row.targetId)}` : ''}
                    </td>
                    <td>
                      <ReversalCell
                        row={row}
                        onReversed={() => {
                          setActionError(null);
                          setActionOk(`Reversed ${row.action}.`);
                          list.reload();
                        }}
                        onError={(err) => {
                          setActionOk(null);
                          setActionError(apiErrorMessage(err));
                        }}
                      />
                    </td>
                    <td>
                      {row.metadata ? (
                        <pre className="metadata-pre">{summarizeMetadata(row.metadata)}</pre>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {list.pagination && <Pagination pagination={list.pagination} onPage={list.setPage} />}
        </>
      )}
    </div>
  );
}

// Admin V2 — SUPER_ADMIN-only audit reversal. A reversal appends a new
// audit row; the original stays immutable. The reversal linkage is shown
// for rows that were reversed or are themselves reversals.
function ReversalCell({
  row,
  onReversed,
  onError,
}: {
  row: AuditLog;
  onReversed: () => void;
  onError: (err: unknown) => void;
}): React.ReactNode {
  const { client } = useAuth();
  const { isSuperAdmin } = usePermissions();
  const { confirm, dialog } = useConfirm();
  const [reversing, setReversing] = useState(false);

  async function handleReverse(): Promise<void> {
    const confirmed = await confirm({
      title: `Reverse ${row.action}?`,
      message:
        'The server will restore the pre-action state from the audit record. The original row stays in history; this reversal is appended as a new row.',
      confirmLabel: 'Reverse action',
      danger: true,
    });
    if (!confirmed) return;
    setReversing(true);
    try {
      await reverseAuditLog(client, row.id);
      onReversed();
    } catch (err) {
      onError(err);
    } finally {
      setReversing(false);
    }
  }

  return (
    <>
      {dialog}
      {row.reversalOf ? (
        <span className="badge badge-gray" title={`Reversal of ${row.reversalOf}`}>
          Reversal
        </span>
      ) : row.reversedBy ? (
        <span className="badge badge-yellow" title={`Reversed by ${row.reversedBy}`}>
          Reversed
        </span>
      ) : row.reversible && isSuperAdmin ? (
        <button
          type="button"
          className="link-button"
          disabled={reversing}
          onClick={() => void handleReverse()}
        >
          {reversing ? 'Reversing…' : 'Reverse…'}
        </button>
      ) : (
        <span className="muted">—</span>
      )}
    </>
  );
}

function summarizeMetadata(metadata: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(metadata, null, 1);
    return text.length > 400 ? `${text.slice(0, 400)}…` : text;
  } catch {
    return '—';
  }
}
