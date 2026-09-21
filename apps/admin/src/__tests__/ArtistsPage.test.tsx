// Phase 16 — Artists page tests: the verify flow calls the API only
// after explicit confirmation.

import { describe, expect, it } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { ArtistsPage } from '../pages/ArtistsPage';
import { adminUser, jsonResponse, pageEnvelope, renderWithAuth } from './helpers';

const ARTIST_ID = 'artist-0001';

function artistListItem(verified: boolean) {
  return {
    id: ARTIST_ID,
    name: 'Test Artist',
    verified,
    followerCount: 10,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function artistDetail(verified: boolean) {
  return {
    id: ARTIST_ID,
    name: 'Test Artist',
    verified,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    profile: null,
    counts: { albums: 1, tracks: 5, followers: 10 },
  };
}

describe('ArtistsPage', () => {
  function renderArtists() {
    const patchCalls: { url: string; body: unknown }[] = [];
    const result = renderWithAuth(<ArtistsPage />, {
      user: adminUser(),
      fetchHandler: (url, init) => {
        if (url.endsWith('/v1/me')) return jsonResponse(adminUser());
        if (url.endsWith(`/v1/artists/${ARTIST_ID}`) && init?.method === 'PATCH') {
          patchCalls.push({ url, body: JSON.parse(String(init.body)) });
          return jsonResponse(artistDetail(true));
        }
        if (url.endsWith(`/v1/artists/${ARTIST_ID}`)) return jsonResponse(artistDetail(false));
        const u = new URL(url);
        if (u.pathname === '/v1/artists') {
          return jsonResponse(pageEnvelope([artistListItem(false)], 1, 20, 1));
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });
    return { ...result, patchCalls };
  }

  it('calls PATCH only after explicit confirmation', async () => {
    const { patchCalls } = renderArtists();

    expect(await screen.findByText('Test Artist')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    // Detail view loads with the artist unverified.
    expect(await screen.findByText('Unverified')).toBeInTheDocument();

    // Open the confirm dialog, then cancel: no API call.
    fireEvent.click(screen.getByRole('button', { name: 'Verify artist' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('will be marked as verified');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(patchCalls).toHaveLength(0);

    // Confirm this time: the API is called with { verified: true } only.
    fireEvent.click(screen.getByRole('button', { name: 'Verify artist' }));
    const dialog2 = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog2).getByRole('button', { name: 'Verify artist' }));

    expect(await screen.findByText('Verified')).toBeInTheDocument();
    expect(patchCalls).toHaveLength(1);
    const [onlyCall] = patchCalls;
    if (!onlyCall) throw new Error('expected one PATCH call');
    expect(onlyCall.url).toContain(`/v1/artists/${ARTIST_ID}`);
    expect(onlyCall.body).toEqual({ verified: true });
  });
});
