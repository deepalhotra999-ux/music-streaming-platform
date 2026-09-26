// Phase 17 — Moderation page tests: list rendering, filtering, report
// creation, and status transitions (all behind ConfirmDialog).

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { ModerationPage } from '../pages/ModerationPage';
import { adminUser, jsonResponse, pageEnvelope, renderWithAuth } from './helpers';
import type { ModerationReport } from '../api/types';

function makeReport(overrides: Partial<ModerationReport> = {}): ModerationReport {
  return {
    id: 'report-1',
    targetType: 'TRACK',
    targetId: 'track-abc',
    reason: 'Suspected spam upload',
    details: null,
    status: 'OPEN',
    createdById: 'admin-0001',
    reviewedById: null,
    createdAt: '2026-09-21T12:00:00.000Z',
    updatedAt: '2026-09-21T12:00:00.000Z',
    ...overrides,
  };
}

function renderModeration(reports: ModerationReport[]) {
  return renderWithAuth(<ModerationPage />, {
    user: adminUser(),
    fetchHandler: (url, init) => {
      if (url.endsWith('/v1/me')) return jsonResponse(adminUser());
      const u = new URL(url);
      if (u.pathname === '/v1/admin/moderation-reports') {
        if (init?.method === 'POST') return jsonResponse(makeReport(), 201);
        const page = Number(u.searchParams.get('page') ?? '1');
        const limit = Number(u.searchParams.get('limit') ?? '20');
        return jsonResponse(pageEnvelope(reports, page, limit, reports.length));
      }
      if (u.pathname.startsWith('/v1/admin/moderation-reports/')) {
        const report = reports.find((r) => u.pathname.endsWith(r.id)) ?? makeReport();
        if (init?.method === 'PATCH') {
          const body = JSON.parse(String(init.body ?? '{}'));
          return jsonResponse({ ...report, ...body, updatedAt: '2026-09-21T13:00:00.000Z' });
        }
        return jsonResponse(report);
      }
      if (u.pathname === '/v1/admin/audit-logs') {
        return jsonResponse(pageEnvelope([], 1, 50, 0));
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
}

/** Clicks the confirm button inside the open ConfirmDialog. */
async function confirmDialog(confirmLabel: string): Promise<void> {
  const dialog = await screen.findByRole('alertdialog');
  const button = within(dialog).getByRole('button', { name: confirmLabel });
  fireEvent.click(button);
}

describe('ModerationPage', () => {
  it('renders the report list with status badges', async () => {
    renderModeration([
      makeReport(),
      makeReport({ id: 'report-2', status: 'RESOLVED', reason: 'Duplicate content' }),
    ]);

    expect(await screen.findByText('Suspected spam upload')).toBeInTheDocument();
    expect(screen.getByText('Duplicate content')).toBeInTheDocument();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
    expect(screen.getByText('RESOLVED')).toBeInTheDocument();
  });

  it('wires status and target-type filters to query params', async () => {
    const { fetchMock } = renderModeration([makeReport()]);

    expect(await screen.findByText('Suspected spam upload')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'OPEN' } });
    fireEvent.change(screen.getByLabelText('Target type'), { target: { value: 'TRACK' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/v1/admin/moderation-reports?'),
      );
      const last = calls[calls.length - 1];
      if (!last) throw new Error('expected a filtered request');
      expect(String(last[0])).toContain('status=OPEN');
      expect(String(last[0])).toContain('targetType=TRACK');
    });
  });

  it('shows an empty state when no reports match', async () => {
    renderModeration([]);
    expect(
      await screen.findByText('No moderation reports match the current filters.'),
    ).toBeInTheDocument();
  });

  it('opens the create form and files a report after confirmation', async () => {
    const { fetchMock } = renderModeration([makeReport()]);

    expect(await screen.findByText('Suspected spam upload')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'File report' }));

    fireEvent.change(screen.getByLabelText('Target ID (UUID)'), {
      target: { value: 'track-xyz' },
    });
    fireEvent.change(screen.getByLabelText('Reason'), {
      target: { value: 'Test reason' },
    });
    // Submit the form — the form's submit button is also "File report".
    const form = screen.getByLabelText('Reason').closest('form');
    if (!form) throw new Error('create form not found');
    const submitButton = within(form).getByRole('button', { name: 'File report' });
    fireEvent.click(submitButton);

    await confirmDialog('File report');

    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith('/v1/admin/moderation-reports') && init?.method === 'POST',
      );
      expect(posts.length).toBe(1);
      const body = JSON.parse(String(posts[0][1]?.body ?? '{}'));
      expect(body.targetType).toBe('TRACK');
      expect(body.targetId).toBe('track-xyz');
      expect(body.reason).toBe('Test reason');
    });
  });

  it('opens report detail and shows the review actions', async () => {
    renderModeration([makeReport()]);

    expect(await screen.findByText('Suspected spam upload')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review report report-1' }));

    // Detail view header + history section.
    expect(await screen.findByRole('heading', { name: /Report/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark under review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark resolved' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark dismissed' })).toBeInTheDocument();
  });

  it('marks a report resolved after confirmation and PATCHes the new status', async () => {
    const { fetchMock } = renderModeration([makeReport()]);

    expect(await screen.findByText('Suspected spam upload')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review report report-1' }));

    const resolveButton = await screen.findByRole('button', { name: 'Mark resolved' });
    fireEvent.click(resolveButton);

    await confirmDialog('Mark resolved');

    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/v1/admin/moderation-reports/report-1') && init?.method === 'PATCH',
      );
      expect(patches.length).toBe(1);
      const body = JSON.parse(String(patches[0][1]?.body ?? '{}'));
      expect(body.status).toBe('RESOLVED');
    });
  });

  it('shows terminal-state messaging for closed reports', async () => {
    renderModeration([makeReport({ id: 'report-9', status: 'DISMISSED' })]);

    expect(await screen.findByText('Suspected spam upload')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review report report-9' }));

    expect(await screen.findByText(/This report is closed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark resolved' })).not.toBeInTheDocument();
  });
});

// Phase 29 — community content review tests live in the same suite because
// the report detail view now embeds the post/comment review card.

function makeCommunityPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    artist: { id: 'artist-1', name: 'The Band', verified: true },
    author: { id: 'user-1', displayName: 'The Band', avatarUrl: null },
    body: 'New single out Friday!',
    track: null,
    album: null,
    status: 'ACTIVE',
    reactionCount: 5,
    commentCount: 2,
    publishedAt: '2026-09-26T10:00:00.000Z',
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    ...overrides,
  };
}

function makeCommunityComment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'comment-1',
    postId: 'post-1',
    author: { id: 'user-2', displayName: 'Fan Person', avatarUrl: null },
    body: 'Love this track!',
    status: 'ACTIVE',
    createdAt: '2026-09-26T11:00:00.000Z',
    updatedAt: '2026-09-26T11:00:00.000Z',
    ...overrides,
  };
}

function renderModerationWithCommunity(reports: ModerationReport[]) {
  return renderWithAuth(<ModerationPage />, {
    user: adminUser(),
    fetchHandler: (url) => {
      if (url.endsWith('/v1/me')) return jsonResponse(adminUser());
      const u = new URL(url);
      if (u.pathname === '/v1/admin/moderation-reports') {
        return jsonResponse(pageEnvelope(reports, 1, 20, reports.length));
      }
      if (u.pathname.startsWith('/v1/admin/moderation-reports/')) {
        return jsonResponse(reports[0] ?? makeReport());
      }
      if (u.pathname === '/v1/admin/audit-logs') {
        return jsonResponse(pageEnvelope([], 1, 50, 0));
      }
      const postMatch = u.pathname.match(
        /^\/v1\/admin\/community\/posts\/([^/]+)(\/(moderate|restore))?$/,
      );
      if (postMatch) {
        const action = postMatch[3];
        const status = action === 'moderate' ? 'REMOVED' : 'ACTIVE';
        return jsonResponse(makeCommunityPost({ status }));
      }
      const commentMatch = u.pathname.match(
        /^\/v1\/admin\/community\/comments\/([^/]+)(\/(moderate|restore))?$/,
      );
      if (commentMatch) {
        const action = commentMatch[3];
        const status = action === 'moderate' ? 'REMOVED' : 'ACTIVE';
        return jsonResponse(makeCommunityComment({ status }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    },
  });
}

describe('community content moderation (Phase 29)', () => {
  it('shows the reported post with safe author info and a Remove action', async () => {
    renderModerationWithCommunity([
      makeReport({ id: 'report-p1', targetType: 'ARTIST_POST', targetId: 'post-1' }),
    ]);

    expect(await screen.findByText('Suspected spam upload')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review report report-p1' }));

    expect(await screen.findByRole('heading', { name: 'Reported post' })).toBeInTheDocument();
    expect(await screen.findByText('New single out Friday!')).toBeInTheDocument();
    expect(screen.getByText('The Band ✓')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove content' })).toBeInTheDocument();
    // No private user data leaks into the review UI.
    expect(screen.queryByText(/user-1/)).not.toBeInTheDocument();
  });

  it('removes a post after confirmation and offers Restore', async () => {
    const { fetchMock } = renderModerationWithCommunity([
      makeReport({ id: 'report-p1', targetType: 'ARTIST_POST', targetId: 'post-1' }),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Review report report-p1' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove content' }));
    await confirmDialog('Remove');

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/v1/admin/community/posts/post-1/moderate'),
      );
      expect(calls.length).toBe(1);
      expect(calls[0][1]?.method).toBe('POST');
    });

    expect(await screen.findByRole('button', { name: 'Restore content' })).toBeInTheDocument();
  });

  it('shows the reported comment with a Remove action', async () => {
    renderModerationWithCommunity([
      makeReport({ id: 'report-c1', targetType: 'POST_COMMENT', targetId: 'comment-1' }),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Review report report-c1' }));

    expect(await screen.findByRole('heading', { name: 'Reported comment' })).toBeInTheDocument();
    expect(await screen.findByText('Love this track!')).toBeInTheDocument();
    expect(screen.getByText('Fan Person')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove content' })).toBeInTheDocument();
  });

  it('restores a removed comment after confirmation', async () => {
    const { fetchMock } = renderModerationWithCommunity([
      makeReport({ id: 'report-c1', targetType: 'POST_COMMENT', targetId: 'comment-1' }),
    ]);

    fireEvent.click(await screen.findByRole('button', { name: 'Review report report-c1' }));
    // First remove it so the UI shows Restore.
    fireEvent.click(await screen.findByRole('button', { name: 'Remove content' }));
    await confirmDialog('Remove');
    const restore = await screen.findByRole('button', { name: 'Restore content' });
    fireEvent.click(restore);
    await confirmDialog('Restore');

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/v1/admin/community/comments/comment-1/restore'),
      );
      expect(calls.length).toBe(1);
    });
  });

  it('offers the new target types in the queue filter', async () => {
    renderModeration([makeReport()]);

    expect(await screen.findByText('Suspected spam upload')).toBeInTheDocument();
    const filter = screen.getByLabelText('Target type');
    expect(within(filter).getByRole('option', { name: 'Artist post' })).toBeInTheDocument();
    expect(within(filter).getByRole('option', { name: 'Post comment' })).toBeInTheDocument();
  });
});

describe('moderation badges', () => {
  it('renders all moderation statuses', async () => {
    const { ModerationStatusBadge } = await import('../components/Badges');
    const { render } = await import('@testing-library/react');
    const statuses = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'] as const;
    for (const status of statuses) {
      const { unmount } = render(<ModerationStatusBadge status={status} />);
      expect(screen.getByText(status.replace('_', ' '))).toBeInTheDocument();
      unmount();
    }
  });

  it('renders account status badges', async () => {
    const { AccountStatusBadge } = await import('../components/Badges');
    const { render } = await import('@testing-library/react');
    const { unmount } = render(<AccountStatusBadge deletedAt={null} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    unmount();
    render(<AccountStatusBadge deletedAt="2026-09-21T00:00:00.000Z" />);
    expect(screen.getByText('Deleted')).toBeInTheDocument();
  });
});
