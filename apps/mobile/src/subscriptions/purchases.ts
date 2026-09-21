// Phase 19 — store purchase state machine.
//
// The client NEVER grants entitlement. The flow is:
//   1. Fetch purchasable products from the backend (product IDs come from
//      the server's plan table; the client never hard-codes SKUs).
//   2. expo-iap `requestPurchase` — the store charges the user and returns
//      a purchase token. This alone grants NOTHING.
//   3. Send the token to the backend (`verifyPurchase`). The backend
//      verifies it against Apple/Google; only a verified purchase creates
//      or updates a subscription.
//   4. Refresh the subscription from the backend — the server is the only
//      authority on entitlement.
//
// Purchase states: idle → loading-products → ready → purchasing →
// verifying → success | failed | canceled. Restore follows the same path
// via `getAvailablePurchases`.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  fetchProducts,
  finishTransaction,
  getAvailablePurchases,
  initConnection,
  purchaseErrorListener,
  purchaseUpdatedListener,
  requestPurchase,
  type Product,
  type Purchase,
} from 'expo-iap';
import {
  apiErrorMessage,
  getStoreProducts,
  verifyPurchase as verifyPurchaseApi,
  type ApiClient,
  type StoreProduct,
} from '../api';

export type PurchaseFlowState =
  | 'idle'
  | 'loading-products'
  | 'ready'
  | 'purchasing'
  | 'verifying'
  | 'success'
  | 'failed'
  | 'canceled'
  | 'restoring';

export interface PurchaseFlowResult {
  state: PurchaseFlowState;
  /** Server-defined products (with store IDs) — null until loaded. */
  products: StoreProduct[] | null;
  /** Store product details from expo-iap (price, title) keyed by SKU. */
  storeDetails: Record<string, Product>;
  error: string | null;
  /** Load products from the backend + store. */
  load: () => void;
  /** Start a purchase for the given store product ID. */
  purchase: (storeProductId: string) => void;
  /** Restore previous purchases (sends each token to the backend). */
  restore: () => void;
  /** Reset to idle (e.g. after dismissing the sheet). */
  reset: () => void;
}

interface PurchasesDeps {
  /** Injectable expo-iap surface for deterministic tests. */
  iap?: {
    initConnection: typeof initConnection;
    fetchProducts: typeof fetchProducts;
    requestPurchase: typeof requestPurchase;
    getAvailablePurchases: typeof getAvailablePurchases;
    finishTransaction: typeof finishTransaction;
    purchaseUpdatedListener: typeof purchaseUpdatedListener;
    purchaseErrorListener: typeof purchaseErrorListener;
  };
}

/**
 * usePurchaseFlow — drives the store purchase UI.
 *
 * @param api Authenticated API client (null = idle).
 * @param onVerified Called after the backend confirms a verified purchase,
 *   so the caller can refresh subscription state. Entitlement is still
 *   read from the server, never set here.
 */
export function usePurchaseFlow(
  api: ApiClient | null,
  onVerified?: () => void,
  deps?: PurchasesDeps,
): PurchaseFlowResult {
  const iap = deps?.iap ?? {
    initConnection,
    fetchProducts,
    requestPurchase,
    getAvailablePurchases,
    finishTransaction,
    purchaseUpdatedListener,
    purchaseErrorListener,
  };

  const [state, setState] = useState<PurchaseFlowState>('idle');
  const [products, setProducts] = useState<StoreProduct[] | null>(null);
  const [storeDetails, setStoreDetails] = useState<Record<string, Product>>({});
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const pendingPurchase = useRef<{ productId: string } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Send a store purchase token to the backend for verification. */
  const verifyToken = useCallback(
    async (purchase: Purchase): Promise<boolean> => {
      if (!api) return false;
      // Apple: transactionId (the JWS comes from the notification path on
      // re-verify); Google: purchaseToken. expo-iap normalizes these.
      const token =
        Platform.OS === 'ios'
          ? (purchase as { transactionId?: string }).transactionId
          : (purchase as { purchaseToken?: string }).purchaseToken;
      if (!token) {
        throw new Error('Store purchase did not include a verifiable token.');
      }
      const provider = Platform.OS === 'ios' ? 'apple' : 'google';
      await verifyPurchaseApi(api, provider, token);
      // Only finish the transaction after the backend has verified it.
      // Finishing first would lose the token on verification failure.
      await iap.finishTransaction({ purchase, isConsumable: false });
      return true;
    },
    [api, iap],
  );

  const load = useCallback(async () => {
    if (!api) {
      setState('idle');
      return;
    }
    setState('loading-products');
    setError(null);
    try {
      await iap.initConnection();
      const serverProducts = await getStoreProducts(api);
      if (!mounted.current) return;
      setProducts(serverProducts.products);

      // Fetch store-side details (localized price/title) for the SKUs the
      // server configured for this platform.
      const skus = serverProducts.products
        .map((p: StoreProduct) => (Platform.OS === 'ios' ? p.appleProductId : p.googleProductId))
        .filter((s: string | null): s is string => typeof s === 'string' && s.length > 0);
      if (skus.length > 0) {
        const details = await iap.fetchProducts({ skus, type: 'subs' });
        if (!mounted.current) return;
        const byId: Record<string, Product> = {};
        for (const d of details ?? []) byId[d.id] = d as Product;
        setStoreDetails(byId);
      }
      if (!mounted.current) return;
      setState('ready');
    } catch (err) {
      if (!mounted.current) return;
      setError(apiErrorMessage(err));
      setState('failed');
    }
  }, [api, iap]);

  const purchase = useCallback(
    async (storeProductId: string) => {
      if (state !== 'ready') return;
      setState('purchasing');
      setError(null);
      pendingPurchase.current = { productId: storeProductId };
      try {
        if (Platform.OS === 'ios') {
          await iap.requestPurchase({ request: { apple: { sku: storeProductId } }, type: 'subs' });
        } else {
          await iap.requestPurchase({
            request: { google: { skus: [storeProductId] } },
            type: 'subs',
          });
        }
        // The result arrives via purchaseUpdatedListener / purchaseErrorListener.
      } catch (err) {
        if (!mounted.current) return;
        setError(apiErrorMessage(err));
        setState('failed');
      }
    },
    [iap, state],
  );

  const restore = useCallback(async () => {
    if (!api) return;
    setState('restoring');
    setError(null);
    try {
      const purchases = await iap.getAvailablePurchases();
      let verifiedAny = false;
      for (const p of purchases) {
        try {
          const ok = await verifyToken(p);
          verifiedAny = verifiedAny || ok;
        } catch {
          // A single bad token must not block the rest.
        }
      }
      if (!mounted.current) return;
      setState(verifiedAny ? 'success' : 'failed');
      if (!verifiedAny) setError('No restorable purchases found.');
      if (verifiedAny) onVerified?.();
    } catch (err) {
      if (!mounted.current) return;
      setError(apiErrorMessage(err));
      setState('failed');
    }
  }, [api, iap, verifyToken, onVerified]);

  const reset = useCallback(() => {
    setState('idle');
    setError(null);
    pendingPurchase.current = null;
  }, []);

  // Wire store callbacks once. A purchase callback alone NEVER grants
  // entitlement — it only triggers server verification.
  useEffect(() => {
    const updatedSub = iap.purchaseUpdatedListener(async (purchase: Purchase) => {
      if (!mounted.current) return;
      // Ignore callbacks that don't belong to an in-flight purchase or restore.
      if (state !== 'purchasing' && state !== 'restoring') return;
      setState('verifying');
      try {
        await verifyToken(purchase);
        if (!mounted.current) return;
        setState('success');
        onVerified?.();
      } catch (err) {
        if (!mounted.current) return;
        setError(apiErrorMessage(err));
        setState('failed');
      }
    });
    const errorSub = iap.purchaseErrorListener((err) => {
      if (!mounted.current) return;
      // User cancellation is a normal outcome, not an error.
      const code = (err as { code?: string }).code ?? '';
      if (code === 'E_USER_CANCELLED' || /cancel/i.test(err.message ?? '')) {
        setState('canceled');
        return;
      }
      setError(err.message ?? 'Purchase failed.');
      setState('failed');
    });
    return () => {
      updatedSub.remove();
      errorSub.remove();
    };
    // Note: `iap`, `verifyToken`, `onVerified`, `state` are intentionally the
    // only deps; the listener closure must not re-register on product changes.
  }, [iap, verifyToken, onVerified, state]);

  return { state, products, storeDetails, error, load, purchase, restore, reset };
}
