// Phase 30 — payment provider resolution.
//
// One configured provider per deployment (config.commerce.paymentProvider).
// Adding a production provider means implementing CommercePaymentProvider
// in this directory and registering it here — the commerce service code
// does not change.

import type { Config } from '../../../config.js';
import { MockPaymentProvider } from './mockProvider.js';
import type { CommercePaymentProvider } from './provider.js';

export * from './provider.js';
export {
  buildMockWebhookPayload,
  completeMockPayment,
  MockPaymentProvider,
  resetMockPaymentState,
  setMockPaymentScenario,
} from './mockProvider.js';

export function resolvePaymentProvider(config: Config): CommercePaymentProvider {
  const id = config.commerce.paymentProvider;
  if (id === 'mock') {
    return new MockPaymentProvider(config.commerce.mockWebhookSecret);
  }
  // parseCommercePaymentProvider already rejects unknown ids at startup;
  // this is defense in depth.
  throw new Error(`No commerce payment adapter configured for provider "${id}".`);
}
