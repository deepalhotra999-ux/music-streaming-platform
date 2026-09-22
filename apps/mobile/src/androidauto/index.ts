// Phase 24 — Android Auto (phone-projected) integration.
//
// Public surface for the Android Auto JS layer: identifiers, native
// bridge, content provider, controller, and host component.

export * from './identifiers';
export { getAndroidAutoNativeModule, resetAndroidAutoNativeModuleCache } from './nativeBridge';
export type { AndroidAutoNativeModule } from './nativeBridge';
export { AndroidAutoContentProvider } from './contentProvider';
export { AndroidAutoController } from './controller';
export type { AndroidAutoControllerDeps } from './controller';
export { AndroidAutoHost } from './AndroidAutoHost';
