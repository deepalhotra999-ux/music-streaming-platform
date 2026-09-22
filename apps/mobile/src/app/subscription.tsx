// Phase 20 — subscription management route.
// Renders the full subscription screen (state, plans, purchase, restore,
// refresh, store management). Authenticated only via the root layout guard.

import { SubscriptionScreen } from '../subscriptions';
import { useAuth } from '../auth';

export default function SubscriptionRoute() {
  const { api } = useAuth();
  return <SubscriptionScreen api={api} />;
}
