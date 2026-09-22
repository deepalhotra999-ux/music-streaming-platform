// Phase 20 — store subscription management.
//
// The app never reproduces store billing functionality. Cancellation, plan
// changes, and payment-method updates happen in the official store UI:
//   - iOS: App Store subscription management (no arguments needed).
//   - Android: Google Play subscriptions, scoped to a SKU + package.
//
// We deep-link out via expo-iap's `deepLinkToSubscriptions`. We do NOT
// claim a cancellation happened until server/store state confirms it —
// this module only opens the store UI.

import { Platform } from 'react-native';
import { deepLinkToSubscriptions } from 'expo-iap';
import Constants from 'expo-constants';

export interface ManageSubscriptionsDeps {
  deepLinkToSubscriptions?: typeof deepLinkToSubscriptions;
  platformOS?: typeof Platform.OS;
  /** Android package name override (defaults to the app's configured package). */
  packageNameAndroid?: string;
}

/**
 * Open the platform's subscription-management UI.
 *
 * @param skuAndroid The Google Play subscription SKU. Required on Android;
 *   ignored on iOS. Comes from the server's product mapping — never
 *   hard-coded.
 * @throws When the store UI cannot be opened (caller surfaces the error).
 */
export async function openStoreSubscriptionManagement(
  skuAndroid: string | null,
  deps: ManageSubscriptionsDeps = {},
): Promise<void> {
  const deepLink = deps.deepLinkToSubscriptions ?? deepLinkToSubscriptions;
  const os = deps.platformOS ?? Platform.OS;

  if (os === 'ios') {
    // App Store: opens the user's subscription list. No arguments.
    await deepLink();
    return;
  }

  if (os === 'android') {
    if (!skuAndroid) {
      throw new Error('No Google Play subscription product is configured.');
    }
    const packageName =
      deps.packageNameAndroid ??
      (Constants.expoConfig?.android?.package as string | undefined) ??
      null;
    if (!packageName) {
      throw new Error('Could not determine the Android package name.');
    }
    await deepLink({ skuAndroid, packageNameAndroid: packageName });
    return;
  }

  throw new Error(`Subscription management is not supported on ${os}.`);
}
