// Phase 17 — moderation queue: list/filter reports, file new reports, and
// review them (status transitions + reason/details edits). Every successful
// mutation is recorded in the audit log server-side; the detail view shows
// the report's history from there.
// Phase 29 — the same queue reviews community reports (ARTIST_POST and
// POST_COMMENT targets): the detail view loads the reported post/comment in
// any moderation state and offers remove/restore actions.

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { apiErrorMessage } from '../api/client';
import {
  createModerationReport,
  getCommunityComment,
  getCommunityPost,
  getModerationReport,
  listModerationReports,
  moderateCommunityComment,
  moderateCommunityPost,
  restoreCommunityComment,
  restoreCommunityPost,
  updateModerationReport,
} from '../api/moderation';
import type { ModerationReportQuery } from '../api/moderation';
import { listAuditLogs } from '../api/audit';
import type {
  AuditLog,
  CommunityComment,
  CommunityPost,
  ModerationReport,
  ModerationStatus,
  ModerationTargetType,
} from '../api/types';
import { useApiList } from '../hooks/useApiList';
import { EmptyState, ErrorState, LoadingState } from '../components/DataStates';
import { Pagination } from '../components/Pagination';
import { ModerationStatusBadge } from '../components/Badges';
import { useConfirm } from '../components/ConfirmDialog';
import { formatDate } from '../utils/format';

type StatusFilter = '' | ModerationStatus;
type TargetFilter = '' | ModerationTargetType;
const PAGE_SIZE = 20;

const NEXT_STATUSES: Record<ModerationStatus, ModerationStatus[]> = {
  OPEN: ['UNDER_REVIEW', 'RESOLVED', 'DISMISSED'],
  UNDER_REVIEW: ['OPEN', 'RESOLVED', 'DISMISSED'],
  RESOLVED: [],
  DISMISSED: [],
};

export function ModerationPage(): React.ReactNode {
  const { client } = useAuth();
  const [statusInput, setStatusInput] = useState<StatusFilter>('');
  const [targetInput, setTargetInput] = useState<TargetFilter>('');
  const [targetIdInput, setTargetIdInput] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const fetcher = useCallback(
    (query: ModerationReportQuery) => listModerationReports(client, { ...query, limit: PAGE_SIZE }),
    [client],
  );
  const list = useApiList(fetcher, { page: 1 } as ModerationReportQuery);

  function handleSearch(event: FormEvent): void {
    event.preventDefault();
    list.setQuery({
      status: statusInput || undefined,
      targetType: targetInput || undefined,
      targetId: targetIdInput.trim() || undefined,
    });
  }

  function clearFilters(): void {
    setStatusInput('');
    setTargetInput('');
    setTargetIdInput('');
    list.setQuery({ status: undefined, targetType: undefined, targetId: undefined });
  }

  return (
    <div>
      <div className="page-header">
        <h1>Moderation</h1>
        <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
          File report
        </button>
      </div>

      {showCreate ? (
        <CreateReportForm
          onCreated={(report) => {
            setShowCreate(false);
            setSelectedId(report.id);
            void list.reload();
          }}
          onCancel={() => setShowCreate(false)}
        />
      ) : selectedId ? (
        <ReportDetailView
          id={selectedId}
          onBack={() => setSelectedId(null)}
          onChanged={list.reload}
        />
      ) : (
        <>
          <form className="toolbar" onSubmit={handleSearch}>
            <div className="field">
              <label htmlFor="mod-status">Status</label>
              <select
                id="mod-status"
                value={statusInput}
                onChange={(event) => setStatusInput(event.target.value as StatusFilter)}
              >
                <option value="">All</option>
                <option value="OPEN">Open</option>
                <option value="UNDER_REVIEW">Under review</option>
                <option value="RESOLVED">Resolved</option>
                <option value="DISMISSED">Dismissed</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="mod-target-type">Target type</label>
              <select
                id="mod-target-type"
                value={targetInput}
                onChange={(event) => setTargetInput(event.target.value as TargetFilter)}
              >
                <option value="">All</option>
                <option value="ARTIST">Artist</option>
                <option value="ALBUM">Album</option>
                <option value="TRACK">Track</option>
                <option value="ARTIST_POST">Artist post</option>
                <option value="POST_COMMENT">Post comment</option>
              </select>
            </div>
            <div className="field search-input">
              <label htmlFor="mod-target-id">Target ID</label>
              <input
                id="mod-target-id"
                type="search"
                placeholder="UUID of the flagged content…"
                value={targetIdInput}
                onChange={(event) => setTargetIdInput(event.target.value)}
              />
            </div>
            <button type="submit" className="btn">
              Search
            </button>
            <button type="button" className="btn" onClick={clearFilters}>
              Clear
            </button>
          </form>

          {list.loading ? (
            <LoadingState label="Loading reports…" />
          ) : list.error ? (
            <ErrorState error={list.error} onRetry={list.reload} />
          ) : list.data.length === 0 ? (
            <EmptyState message="No moderation reports match the current filters." />
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Target</th>
                      <th>Reason</th>
                      <th>Filed</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.map((report) => (
                      <tr key={report.id}>
                        <td>
                          <ModerationStatusBadge status={report.status} />
                        </td>
                        <td>
                          <span className="mono" style={{ fontSize: 12 }}>
                            {report.targetType}
                          </span>
                        </td>
                        <td>{report.reason}</td>
                        <td>{formatDate(report.createdAt)}</td>
                        <td>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => setSelectedId(report.id)}
                          >
                            Review
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {list.pagination && <Pagination pagination={list.pagination} onPage={list.setPage} />}
            </>
          )}
        </>
      )}
    </div>
  );
}

function CreateReportForm({
  onCreated,
  onCancel,
}: {
  onCreated: (report: ModerationReport) => void;
  onCancel: () => void;
}): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [targetType, setTargetType] = useState<ModerationTargetType>('TRACK');
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const confirmed = await confirm({
      title: 'File moderation report?',
      message: `This will flag the ${targetType.toLowerCase()} ${targetId.trim()} for operator review. The report and your identity as the filing admin are recorded in the audit log.`,
      confirmLabel: 'File report',
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      const report = await createModerationReport(client, {
        targetType,
        targetId: targetId.trim(),
        reason: reason.trim(),
        details: details.trim() || undefined,
      });
      onCreated(report);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>File moderation report</h2>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <form onSubmit={(event) => void handleSubmit(event)}>
        <div className="field">
          <label htmlFor="create-target-type">Target type</label>
          <select
            id="create-target-type"
            value={targetType}
            onChange={(event) => setTargetType(event.target.value as ModerationTargetType)}
          >
            <option value="ARTIST">Artist</option>
            <option value="ALBUM">Album</option>
            <option value="TRACK">Track</option>
            <option value="ARTIST_POST">Artist post</option>
            <option value="POST_COMMENT">Post comment</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="create-target-id">Target ID (UUID)</label>
          <input
            id="create-target-id"
            type="text"
            placeholder="Copy the artist, album, or track ID from its detail view…"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="create-reason">Reason</label>
          <input
            id="create-reason"
            type="text"
            placeholder="e.g. Suspected spam upload"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
            minLength={3}
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor="create-details">Details (optional)</label>
          <textarea
            id="create-details"
            rows={3}
            maxLength={2000}
            placeholder="Operator notes, evidence summary…"
            value={details}
            onChange={(event) => setDetails(event.target.value)}
          />
        </div>
        <div className="toolbar">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Filing…' : 'File report'}
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
      {dialog}
    </div>
  );
}

function ReportDetailView({
  id,
  onBack,
  onChanged,
}: {
  id: string;
  onBack: () => void;
  onChanged: () => void;
}): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [report, setReport] = useState<ModerationReport | null>(null);
  const [history, setHistory] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [fetched, audit] = await Promise.all([
        getModerationReport(client, id),
        listAuditLogs(client, { targetType: 'moderation_report', targetId: id, limit: 50 }),
      ]);
      setReport(fetched);
      setHistory(audit.data);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [client, id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleStatusChange(next: ModerationStatus): Promise<void> {
    if (!report || next === report.status) return;
    setActionError(null);
    const confirmed = await confirm({
      title: `Mark report as ${next.replace('_', ' ').toLowerCase()}?`,
      message:
        next === 'RESOLVED' || next === 'DISMISSED'
          ? 'This closes the report permanently — resolved and dismissed reports cannot be reopened. File a new report if the issue recurs. This action is recorded in the audit log.'
          : `The report will move to ${next.replace('_', ' ').toLowerCase()}. This action is recorded in the audit log.`,
      confirmLabel: `Mark ${next.replace('_', ' ').toLowerCase()}`,
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      const updated = await updateModerationReport(client, report.id, { status: next });
      setReport(updated);
      onChanged();
      // Refresh history so the new audit row shows immediately.
      const audit = await listAuditLogs(client, {
        targetType: 'moderation_report',
        targetId: id,
        limit: 50,
      });
      setHistory(audit.data);
    } catch (err) {
      setActionError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <LoadingState label="Loading report…" />;
  if (error) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!report) return <EmptyState message="Report not found." />;

  const nextStatuses = NEXT_STATUSES[report.status];

  return (
    <div>
      <button type="button" className="link-button back-link" onClick={onBack}>
        ← Back to moderation queue
      </button>
      {actionError && (
        <div className="form-error" role="alert">
          {actionError}
        </div>
      )}
      <div className="card">
        <h2>
          Report <ModerationStatusBadge status={report.status} />
        </h2>
        <div className="detail-grid">
          <div className="detail-item">
            <p className="detail-label">Report ID</p>
            <p className="detail-value mono">{report.id}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Target</p>
            <p className="detail-value mono">
              {report.targetType} · {report.targetId}
            </p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Reason</p>
            <p className="detail-value">{report.reason}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Details</p>
            <p className="detail-value">{report.details || '—'}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Filed</p>
            <p className="detail-value">{formatDate(report.createdAt)}</p>
          </div>
          <div className="detail-item">
            <p className="detail-label">Last updated</p>
            <p className="detail-value">{formatDate(report.updatedAt)}</p>
          </div>
        </div>
      </div>

      <CommunityContentCard report={report} />

      <div className="card">
        <h2>Review actions</h2>
        {nextStatuses.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            This report is closed. Resolved and dismissed reports are terminal — file a new report
            if the issue recurs.
          </p>
        ) : (
          <div className="toolbar">
            {nextStatuses.map((next) => (
              <button
                key={next}
                type="button"
                className={next === 'DISMISSED' ? 'btn btn-outline-danger' : 'btn btn-primary'}
                disabled={saving}
                onClick={() => void handleStatusChange(next)}
              >
                {saving ? 'Saving…' : `Mark ${next.replace('_', ' ').toLowerCase()}`}
              </button>
            ))}
          </div>
        )}
        <p className="muted" style={{ fontSize: 13 }}>
          Every status change is recorded in the audit log with the acting administrator.
        </p>
      </div>

      <div className="card">
        <h2>History</h2>
        {history.length === 0 ? (
          <p className="muted" style={{ fontSize: 13 }}>
            No audit history for this report yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Details</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id}>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {entry.action}
                    </td>
                    <td style={{ fontSize: 13 }}>{describeAuditEntry(entry)}</td>
                    <td>{formatDate(entry.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {dialog}
    </div>
  );
}

/**
 * Phase 29 — community content review. For ARTIST_POST and POST_COMMENT
 * reports this card loads the reported post/comment in any moderation state
 * and lets the admin remove or restore it. Only the safe public author DTO
 * (display name) is shown — never emails, roles, or private user data.
 */
function CommunityContentCard({ report }: { report: ModerationReport }): React.ReactNode {
  const { client } = useAuth();
  const { confirm, dialog } = useConfirm();
  const [post, setPost] = useState<CommunityPost | null>(null);
  const [comment, setComment] = useState<CommunityComment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isPost = report.targetType === 'ARTIST_POST';
  const isComment = report.targetType === 'POST_COMMENT';

  useEffect(() => {
    if (!isPost && !isComment) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = isPost
      ? getCommunityPost(client, report.targetId).then((p) => {
          if (!cancelled) {
            setPost(p);
            setComment(null);
          }
        })
      : getCommunityComment(client, report.targetId).then((c) => {
          if (!cancelled) {
            setComment(c);
            setPost(null);
          }
        });
    load.catch((err: unknown) => {
      if (!cancelled) setError(apiErrorMessage(err));
    });
    load.finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [client, isPost, isComment, report.targetId]);

  if (!isPost && !isComment) return null;

  const status = post?.status ?? comment?.status ?? null;
  const author = post?.author ?? comment?.author ?? null;

  async function handleAction(action: 'remove' | 'restore'): Promise<void> {
    const label = action === 'remove' ? 'Remove' : 'Restore';
    const confirmed = await confirm({
      title: `${label} this ${isPost ? 'post' : 'comment'}?`,
      message:
        action === 'remove'
          ? 'The content will be hidden from feeds, profiles, and search. It can be restored later. This action is recorded in the audit log.'
          : 'The content will become visible again in feeds, profiles, and search. This action is recorded in the audit log.',
      confirmLabel: label,
    });
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    try {
      if (isPost) {
        const updated =
          action === 'remove'
            ? await moderateCommunityPost(client, report.targetId)
            : await restoreCommunityPost(client, report.targetId);
        setPost(updated);
      } else {
        const updated =
          action === 'remove'
            ? await moderateCommunityComment(client, report.targetId)
            : await restoreCommunityComment(client, report.targetId);
        setComment(updated);
      }
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <h2>Reported {isPost ? 'post' : 'comment'}</h2>
      {loading ? (
        <LoadingState label="Loading content…" />
      ) : error ? (
        <ErrorState error={error} onRetry={() => window.location.reload()} />
      ) : (
        <>
          <div className="detail-grid">
            <div className="detail-item">
              <p className="detail-label">Author</p>
              <p className="detail-value">{author?.displayName ?? '—'}</p>
            </div>
            {post && (
              <div className="detail-item">
                <p className="detail-label">Artist</p>
                <p className="detail-value">
                  {post.artist.name}
                  {post.artist.verified ? ' ✓' : ''}
                </p>
              </div>
            )}
            <div className="detail-item">
              <p className="detail-label">Status</p>
              <p className="detail-value mono">{status ?? '—'}</p>
            </div>
            {post && post.track && (
              <div className="detail-item">
                <p className="detail-label">Attached track</p>
                <p className="detail-value">{post.track.title}</p>
              </div>
            )}
          </div>
          <div className="detail-item" style={{ marginTop: 12 }}>
            <p className="detail-label">Content</p>
            <p className="detail-value" style={{ whiteSpace: 'pre-wrap' }}>
              {post?.body ?? comment?.body ?? '—'}
            </p>
          </div>
          <div className="toolbar" style={{ marginTop: 12 }}>
            {status !== 'REMOVED' ? (
              <button
                type="button"
                className="btn btn-outline-danger"
                disabled={saving}
                onClick={() => void handleAction('remove')}
              >
                {saving ? 'Removing…' : 'Remove content'}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving}
                onClick={() => void handleAction('restore')}
              >
                {saving ? 'Restoring…' : 'Restore content'}
              </button>
            )}
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            Removed content stays hidden from ordinary users; only admins can restore it. Every
            action is recorded in the immutable audit log.
          </p>
        </>
      )}
      {dialog}
    </div>
  );
}

function describeAuditEntry(entry: AuditLog): string {
  const meta = (entry.metadata ?? {}) as Record<string, unknown>;
  if (entry.action === 'moderation.report.status_changed') {
    return `${String(meta.oldStatus ?? '?')} → ${String(meta.newStatus ?? '?')}`;
  }
  if (entry.action === 'moderation.report.updated') {
    const fields = meta.fields as string[] | undefined;
    return `Edited: ${(fields ?? []).join(', ') || '—'}`;
  }
  if (entry.action === 'moderation.report.created') {
    return `Filed against ${String(meta.reportTargetType ?? '?')}: ${String(meta.reason ?? '')}`;
  }
  if (entry.action === 'community.post.removed' || entry.action === 'community.comment.removed') {
    return `Content removed (${String(meta.oldStatus ?? '?')} → ${String(meta.newStatus ?? '?')})`;
  }
  if (entry.action === 'community.post.restored' || entry.action === 'community.comment.restored') {
    return `Content restored (${String(meta.oldStatus ?? '?')} → ${String(meta.newStatus ?? '?')})`;
  }
  return '—';
}
