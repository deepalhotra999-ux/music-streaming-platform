// Phase 26 — discovery component tests: the cold-start banner is honest,
// track rows render the server's reason verbatim, and the query bar
// submits trimmed queries.

import { fireEvent, render, screen } from '@testing-library/react-native';
import { ColdStartBanner } from '../components/ColdStartBanner';
import { DiscoveryTrackRow } from '../components/DiscoveryTrackRow';
import { QueryBar } from '../components/QueryBar';
import type { RecommendationItem } from '../types';

const testItem: RecommendationItem = {
  track: {
    id: 't1',
    title: 'Copper Skyline',
    durationMs: 204_000,
    artist: { id: 'a1', name: 'Neon Coastline' },
    album: { id: 'al1', title: 'Glass Horizon' },
  },
  reason: 'Because you played Neon Coastline this week',
  reasonKind: 'because_you_listen',
};

describe('ColdStartBanner', () => {
  it('renders honest copy that never claims personalization', () => {
    render(<ColdStartBanner />);
    const banner = screen.getByTestId('cold-start-banner');
    expect(banner).toBeTruthy();
    const label = banner.props.accessibilityLabel as string;
    expect(label).toMatch(/not personalized/i);
    // The visible copy must not contain "for you" language either.
    expect(screen.getByText(/aren't personalized yet/i)).toBeTruthy();
    expect(screen.queryByText(/for you/i)).toBeNull();
  });
});

describe('DiscoveryTrackRow', () => {
  it('renders the server-provided reason verbatim', () => {
    render(
      <DiscoveryTrackRow item={testItem} index={0} onPress={() => {}} onLongPress={() => {}} />,
    );
    expect(screen.getByText('Because you played Neon Coastline this week')).toBeTruthy();
    expect(screen.getByText('Copper Skyline')).toBeTruthy();
    expect(screen.getByText('Neon Coastline · Glass Horizon')).toBeTruthy();
  });

  it('fires onPress and onLongPress', () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    render(
      <DiscoveryTrackRow item={testItem} index={0} onPress={onPress} onLongPress={onLongPress} />,
    );
    const row = screen.getByTestId('discovery-track-0');
    fireEvent(row, 'press');
    expect(onPress).toHaveBeenCalledTimes(1);
    fireEvent(row, 'longPress');
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('exposes an accessible label including the reason', () => {
    render(
      <DiscoveryTrackRow item={testItem} index={0} onPress={() => {}} onLongPress={() => {}} />,
    );
    const row = screen.getByTestId('discovery-track-0');
    expect(row.props.accessibilityLabel).toMatch(/Copper Skyline/);
    expect(row.props.accessibilityLabel).toMatch(/Because you played/);
  });
});

describe('QueryBar', () => {
  it('submits the trimmed query', () => {
    const onSubmit = jest.fn();
    render(<QueryBar onSubmit={onSubmit} loading={false} />);
    const input = screen.getByTestId('discovery-query-input');
    fireEvent.changeText(input, '  mellow jazz  ');
    fireEvent.press(screen.getByTestId('discovery-query-submit'));
    expect(onSubmit).toHaveBeenCalledWith('mellow jazz');
  });

  it('does not submit empty queries', () => {
    const onSubmit = jest.fn();
    render(<QueryBar onSubmit={onSubmit} loading={false} />);
    fireEvent.changeText(screen.getByTestId('discovery-query-input'), '   ');
    fireEvent.press(screen.getByTestId('discovery-query-submit'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('disables submission while loading', () => {
    const onSubmit = jest.fn();
    render(<QueryBar onSubmit={onSubmit} loading={true} />);
    const submit = screen.getByTestId('discovery-query-submit');
    expect(submit.props.accessibilityState.busy).toBe(true);
    fireEvent.changeText(screen.getByTestId('discovery-query-input'), 'jazz');
    fireEvent.press(submit);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
