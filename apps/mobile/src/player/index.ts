// Phase 9 — player UI module.
//
// UI around the Phase 8 PlaybackEngine: mini player, full-screen player,
// seek bar, transport controls, and queue list. All components subscribe to
// the engine's state via usePlayback; nothing here creates audio playback.

export { FullPlayer, FullPlayerView } from './FullPlayer';
export type { FullPlayerViewProps } from './FullPlayer';
export { MiniPlayer, MiniPlayerView } from './MiniPlayer';
export type { MiniPlayerViewProps } from './MiniPlayer';
export { MiniPlayerHost, shouldShowMiniPlayer } from './MiniPlayerHost';
export { PlayerControls } from './PlayerControls';
export type { PlayerControlsProps } from './PlayerControls';
export { QueueList, QueueRow } from './QueueView';
export { SeekBar, positionMsForX } from './SeekBar';
export { useQueueActions } from './useQueueActions';
