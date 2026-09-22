// Phase 26 — honesty guarantees: the client must never fake
// personalization.
//
// - feedHeading() gives cold-start users an honest non-personalized
//   heading, never "For you".
// - groupByReasonKind() preserves server order and never invents groups.
// - isAIFallback() detects the deterministic-fallback provider so the UI
//   can say the AI was unavailable.
// - PERSONALIZED_REASON_KINDS documents which kinds imply real signals;
//   cold-start responses must not contain them (the backend guarantees
//   this; the client double-checks via feedHeading + ColdStartBanner).

import { groupByReasonKind, isAIFallback } from '../../screens/DiscoveryScreen';
import {
  PERSONALIZED_REASON_KINDS,
  REASON_SECTION_TITLES,
  feedHeading,
  type RecommendationItem,
  type RecommendationsResponse,
} from '../types';

function item(
  id: string,
  reasonKind: RecommendationItem['reasonKind'],
  reason: string,
): RecommendationItem {
  return {
    track: {
      id,
      title: `Track ${id}`,
      durationMs: 180_000,
      artist: { id: `a-${id}`, name: `Artist ${id}` },
      album: null,
    },
    reason,
    reasonKind,
  };
}

function response(personalized: boolean, aiProvider: string): RecommendationsResponse {
  return {
    requestId: 'r1',
    policy: { policyVersion: '1', personalized, aiProvider },
    items: [],
    candidateCount: 0,
    generatedAt: new Date().toISOString(),
  };
}

describe('feedHeading', () => {
  it('says "For you" only for personalized feeds', () => {
    expect(feedHeading(true)).toBe('For you');
  });

  it('never says "For you" for cold-start users', () => {
    const heading = feedHeading(false);
    expect(heading).not.toMatch(/for you/i);
    expect(heading).toBe('Popular right now');
  });
});

describe('groupByReasonKind', () => {
  it('groups items by reason kind in first-appearance order', () => {
    const items = [
      item('t1', 'popular', 'Trending this week'),
      item('t2', 'emerging_artist', 'On the rise'),
      item('t3', 'popular', 'Trending this week'),
    ];
    const groups = groupByReasonKind(items);
    expect(groups.map((g) => g.kind)).toEqual(['popular', 'emerging_artist']);
    expect(groups[0].items.map((i) => i.track.id)).toEqual(['t1', 't3']);
    expect(groups[1].items.map((i) => i.track.id)).toEqual(['t2']);
  });

  it('never invents groups for empty input', () => {
    expect(groupByReasonKind([])).toEqual([]);
  });

  it('has a human title for every reason kind', () => {
    const kinds: RecommendationItem['reasonKind'][] = [
      'because_you_listen',
      'followed_artist',
      'liked_tracks',
      'similar_genre',
      'new_from_followed',
      'emerging_artist',
      'popular',
      'exploration',
    ];
    for (const kind of kinds) {
      expect(REASON_SECTION_TITLES[kind]).toBeTruthy();
    }
  });
});

describe('isAIFallback', () => {
  it('detects the deterministic fallback provider', () => {
    expect(isAIFallback(response(true, 'deterministic-fallback'))).toBe(true);
    expect(isAIFallback(response(true, 'none'))).toBe(false);
    expect(isAIFallback(response(true, 'openai'))).toBe(false);
    expect(isAIFallback(null)).toBe(false);
  });
});

describe('no fake personalization', () => {
  it('cold-start responses must not carry personalized reason kinds', () => {
    // The backend guarantees this; this test pins the client-side
    // contract: if a response is not personalized, none of its items may
    // claim a personalized reason.
    const coldItems = [
      item('t1', 'popular', 'Trending this week'),
      item('t2', 'emerging_artist', 'On the rise'),
    ];
    for (const i of coldItems) {
      expect(PERSONALIZED_REASON_KINDS.has(i.reasonKind)).toBe(false);
    }
  });

  it('documents exactly which reason kinds are personalized', () => {
    expect([...PERSONALIZED_REASON_KINDS].sort()).toEqual(
      [
        'because_you_listen',
        'followed_artist',
        'liked_tracks',
        'new_from_followed',
        'similar_genre',
      ].sort(),
    );
  });
});
