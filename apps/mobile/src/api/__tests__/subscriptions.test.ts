// Phase 18 — subscription endpoint wrappers: verify each wrapper calls the
// right path. The ApiClient is mocked; these tests pin the contract, not
// the transport.

import type { ApiClient } from '../client';
import { getMyEntitlement, getMySubscription } from '../subscriptions';

function mockClient(): jest.Mocked<ApiClient> {
  return {
    get: jest.fn(async () => ({})),
    post: jest.fn(async () => ({})),
  } as unknown as jest.Mocked<ApiClient>;
}

describe('subscription endpoints', () => {
  it('getMySubscription hits /v1/subscriptions/me', async () => {
    const client = mockClient();
    await getMySubscription(client);
    expect(client.get).toHaveBeenCalledWith('/v1/subscriptions/me');
  });

  it('getMyEntitlement hits /v1/subscriptions/me/entitlement', async () => {
    const client = mockClient();
    await getMyEntitlement(client);
    expect(client.get).toHaveBeenCalledWith('/v1/subscriptions/me/entitlement');
  });
});
