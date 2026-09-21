// Phase 5 — splash route. Rendered while AuthProvider restores the session;
// Stack.Protected guards in the root layout redirect once auth resolves.

import { SplashScreen } from '../screens';

export default function SplashRoute() {
  return <SplashScreen />;
}
