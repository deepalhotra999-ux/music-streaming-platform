// Phase 16 — status badges for track processing state.
// Phase 17 — moderation status badges.

import type { ModerationStatus, TrackStatus } from '../api/types';

const STATUS_CLASS: Record<TrackStatus, string> = {
  READY: 'badge-green',
  PROCESSING: 'badge-amber',
  FAILED: 'badge-red',
  TAKEDOWN: 'badge-gray',
};

export function StatusBadge({ status }: { status: TrackStatus }): React.ReactNode {
  const className = STATUS_CLASS[status] ?? 'badge-gray';
  return <span className={`badge ${className}`}>{status}</span>;
}

const MODERATION_STATUS_CLASS: Record<ModerationStatus, string> = {
  OPEN: 'badge-red',
  UNDER_REVIEW: 'badge-amber',
  RESOLVED: 'badge-green',
  DISMISSED: 'badge-gray',
};

export function ModerationStatusBadge({ status }: { status: ModerationStatus }): React.ReactNode {
  const className = MODERATION_STATUS_CLASS[status] ?? 'badge-gray';
  return <span className={`badge ${className}`}>{status.replace('_', ' ')}</span>;
}

export function AccountStatusBadge({ deletedAt }: { deletedAt: string | null }): React.ReactNode {
  return deletedAt ? (
    <span className="badge badge-gray">Deleted</span>
  ) : (
    <span className="badge badge-green">Active</span>
  );
}

export function VerifiedBadge({ verified }: { verified: boolean }): React.ReactNode {
  return verified ? (
    <span className="badge badge-green">Verified</span>
  ) : (
    <span className="badge badge-gray">Unverified</span>
  );
}

export function RoleBadge({ role }: { role: string }): React.ReactNode {
  const className =
    role === 'ADMIN' ? 'badge-red' : role === 'ARTIST' ? 'badge-amber' : 'badge-gray';
  return <span className={`badge ${className}`}>{role}</span>;
}
