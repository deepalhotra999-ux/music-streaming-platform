// Phase 20 — store subscription management tests.
//
// Verifies that "Manage subscription" deep-links to the official store UI:
// - iOS: App Store subscription management (no arguments).
// - Android: Google Play with SKU + package name (from server config).
// - Never claims a cancellation happened; only opens the store UI.

import { openStoreSubscriptionManagement } from '../manageSubscription';

describe('openStoreSubscriptionManagement', () => {
  it('opens App Store management on iOS with no arguments', async () => {
    const deepLinkToSubscriptions = jest.fn(async () => {});
    await openStoreSubscriptionManagement(null, {
      deepLinkToSubscriptions,
      platformOS: 'ios',
    });
    expect(deepLinkToSubscriptions).toHaveBeenCalledWith();
  });

  it('opens Google Play management on Android with SKU and package', async () => {
    const deepLinkToSubscriptions = jest.fn(async () => {});
    await openStoreSubscriptionManagement('waveform.test.premium', {
      deepLinkToSubscriptions,
      platformOS: 'android',
      packageNameAndroid: 'com.waveform.test',
    });
    expect(deepLinkToSubscriptions).toHaveBeenCalledWith({
      skuAndroid: 'waveform.test.premium',
      packageNameAndroid: 'com.waveform.test',
    });
  });

  it('throws on Android when no SKU is configured', async () => {
    const deepLinkToSubscriptions = jest.fn(async () => {});
    await expect(
      openStoreSubscriptionManagement(null, {
        deepLinkToSubscriptions,
        platformOS: 'android',
        packageNameAndroid: 'com.waveform.test',
      }),
    ).rejects.toThrow('No Google Play subscription product is configured');
    expect(deepLinkToSubscriptions).not.toHaveBeenCalled();
  });

  it('throws on unsupported platforms', async () => {
    const deepLinkToSubscriptions = jest.fn(async () => {});
    await expect(
      openStoreSubscriptionManagement(null, {
        deepLinkToSubscriptions,
        platformOS: 'web',
      }),
    ).rejects.toThrow('not supported');
  });
});
