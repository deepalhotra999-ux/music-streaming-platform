// Phase 23 — Apple CarPlay integration (public surface).

export { CarPlayController, type CarPlayControllerDeps } from './controller';
export {
  CarPlayContentProvider,
  type CarPlayNode,
  type CarPlayPlaybackModes,
} from './contentProvider';
export {
  albumNodeId,
  artistNodeId,
  playlistNodeId,
  splitNodeId,
  trackIdFromItemId,
  trackItemId,
  type SplitNodeId,
} from './identifiers';
export {
  getCarPlayNativeModule,
  resetCarPlayNativeModuleCache,
  type CarPlayNativeModule,
} from './nativeBridge';
export { CarPlayHost } from './CarPlayHost';
