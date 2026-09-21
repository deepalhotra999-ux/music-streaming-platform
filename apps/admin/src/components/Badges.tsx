// Phase 16 — status badges for track processing state.

import type { TrackStatus } from '../api/types';

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
