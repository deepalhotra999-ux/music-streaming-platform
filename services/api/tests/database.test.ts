/**
 * Phase 2 database integration tests.
 * Run against TEST_DATABASE_URL (see services/api/.env) — never the dev DB.
 * The suite cleans up after itself; tables are emptied in FK-safe order.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../src/db.js';

const db = new PrismaClient();

async function clean(): Promise<void> {
  // Phase 30 commerce tables first (FK: stores -> artists, orders -> users/stores).
  // commerce_payment_events is append-only (trigger rejects DELETE); disable
  // the trigger for test cleanup like phase4 does for admin_audit_logs.
  await db.$executeRawUnsafe(
    'ALTER TABLE commerce_payment_events DISABLE TRIGGER commerce_payment_events_no_update',
  );
  await db.$executeRawUnsafe(
    'ALTER TABLE commerce_payment_events DISABLE TRIGGER commerce_payment_events_no_delete',
  );
  try {
    await db.commercePaymentEvent.deleteMany();
  } finally {
    await db.$executeRawUnsafe(
      'ALTER TABLE commerce_payment_events ENABLE TRIGGER commerce_payment_events_no_update',
    );
    await db.$executeRawUnsafe(
      'ALTER TABLE commerce_payment_events ENABLE TRIGGER commerce_payment_events_no_delete',
    );
  }
  await db.commerceRefund.deleteMany();
  await db.commercePayment.deleteMany();
  await db.commerceOrderItem.deleteMany();
  await db.commerceOrder.deleteMany();
  await db.cartItem.deleteMany();
  await db.cart.deleteMany();
  await db.inventoryItem.deleteMany();
  await db.productImage.deleteMany();
  await db.productVariant.deleteMany();
  await db.product.deleteMany();
  await db.artistStore.deleteMany();
  await db.listeningHistory.deleteMany();
  await db.like.deleteMany();
  await db.follow.deleteMany();
  await db.playlistTrack.deleteMany();
  await db.playlist.deleteMany();
  await db.trackGenre.deleteMany();
  await db.track.deleteMany();
  await db.album.deleteMany();
  await db.artistProfile.deleteMany();
  await db.artist.deleteMany();
  // subscription_events is append-only (trigger rejects the cascade from
  // subscription deletes); disable it for test cleanup, then re-enable.
  await db.$executeRawUnsafe(
    'ALTER TABLE subscription_events DISABLE TRIGGER subscription_events_no_delete',
  );
  try {
    await db.subscription.deleteMany();
  } finally {
    await db.$executeRawUnsafe(
      'ALTER TABLE subscription_events ENABLE TRIGGER subscription_events_no_delete',
    );
  }
  // admin_audit_logs is append-only (trigger rejects the FK's ON DELETE SET NULL
  // maintenance update); disable it for test cleanup like phase4 does.
  await db.$executeRawUnsafe(
    'ALTER TABLE admin_audit_logs DISABLE TRIGGER admin_audit_logs_no_mutation',
  );
  try {
    await db.user.deleteMany();
  } finally {
    await db.$executeRawUnsafe(
      'ALTER TABLE admin_audit_logs ENABLE TRIGGER admin_audit_logs_no_mutation',
    );
  }
  await db.genre.deleteMany();
}

beforeAll(async () => {
  await clean();
});

afterAll(async () => {
  await clean();
  await db.$disconnect();
  await prisma.$disconnect();
});

describe('database foundation', () => {
  it('creates the full catalog chain: user -> artist -> profile -> album -> track -> genre', async () => {
    const user = await db.user.create({
      data: { email: 'test.owner@example.com', displayName: 'Test Owner', role: 'ARTIST' },
    });
    const artist = await db.artist.create({
      data: {
        name: 'Test Artist',
        ownerUserId: user.id,
        profile: { create: { bio: 'Test bio' } },
      },
      include: { profile: true },
    });
    const album = await db.album.create({
      data: { title: 'Test Album', artistId: artist.id, albumType: 'ALBUM' },
    });
    const genre = await db.genre.create({ data: { name: 'Test Genre' } });
    const track = await db.track.create({
      data: {
        title: 'Test Track',
        artistId: artist.id,
        albumId: album.id,
        durationMs: 180000,
        trackNumber: 1,
        status: 'READY',
        genres: { create: { genreId: genre.id } },
      },
      include: { genres: { include: { genre: true } }, album: true, artist: true },
    });

    expect(track.artist.name).toBe('Test Artist');
    expect(track.album?.title).toBe('Test Album');
    expect(track.genres[0].genre.name).toBe('Test Genre');
    expect(artist.profile?.bio).toBe('Test bio');
    expect(track.playCount).toBe(0n);
    expect(track.createdAt).toBeInstanceOf(Date);
  });

  it('orders playlist tracks by position', async () => {
    const user = await db.user.create({
      data: { email: 'test.playlist@example.com', displayName: 'Playlist User' },
    });
    const artist = await db.artist.create({ data: { name: 'Playlist Artist' } });
    const mkTrack = (title: string, ms: number) =>
      db.track.create({
        data: { title, artistId: artist.id, durationMs: ms, status: 'READY' },
      });
    const [t1, t2, t3] = await Promise.all([
      mkTrack('One', 1000),
      mkTrack('Two', 2000),
      mkTrack('Three', 3000),
    ]);
    const playlist = await db.playlist.create({
      data: {
        title: 'Order Test',
        ownerUserId: user.id,
        items: {
          create: [
            { trackId: t3.id, position: 3, addedByUserId: user.id },
            { trackId: t1.id, position: 1, addedByUserId: user.id },
            { trackId: t2.id, position: 2, addedByUserId: user.id },
          ],
        },
      },
      include: { items: { orderBy: { position: 'asc' }, include: { track: true } } },
    });

    expect(playlist.items.map((i) => i.track.title)).toEqual(['One', 'Two', 'Three']);
  });

  it('rejects duplicate likes and follows (composite PKs)', async () => {
    const user = await db.user.create({
      data: { email: 'test.dedupe@example.com', displayName: 'Dedupe User' },
    });
    const artist = await db.artist.create({ data: { name: 'Dedupe Artist' } });
    const track = await db.track.create({
      data: { title: 'Dedupe Track', artistId: artist.id, durationMs: 1000, status: 'READY' },
    });

    await db.like.create({ data: { userId: user.id, trackId: track.id } });
    await expect(
      db.like.create({ data: { userId: user.id, trackId: track.id } }),
    ).rejects.toThrow();

    await db.follow.create({ data: { userId: user.id, artistId: artist.id } });
    await expect(
      db.follow.create({ data: { userId: user.id, artistId: artist.id } }),
    ).rejects.toThrow();
  });

  it('cascades user-owned rows on user delete', async () => {
    const user = await db.user.create({
      data: { email: 'test.cascade@example.com', displayName: 'Cascade User' },
    });
    const artist = await db.artist.create({ data: { name: 'Cascade Artist' } });
    const track = await db.track.create({
      data: { title: 'Cascade Track', artistId: artist.id, durationMs: 1000, status: 'READY' },
    });
    const playlist = await db.playlist.create({
      data: { title: 'Cascade Playlist', ownerUserId: user.id },
    });
    await db.like.create({ data: { userId: user.id, trackId: track.id } });
    await db.listeningHistory.create({ data: { userId: user.id, trackId: track.id } });

    await db.user.delete({ where: { id: user.id } });

    await expect(db.playlist.findUnique({ where: { id: playlist.id } })).resolves.toBeNull();
    expect(await db.like.count({ where: { userId: user.id } })).toBe(0);
    expect(await db.listeningHistory.count({ where: { userId: user.id } })).toBe(0);
    // Artist owned by nobody here — survives (ownerUserId was null).
    expect(await db.artist.count({ where: { id: artist.id } })).toBe(1);
  });

  it('records subscriptions and listening history (API db module path)', async () => {
    // Uses the API service's own Prisma client (src/db.ts) — verifies the
    // database is reachable through the API's data layer.
    const user = await prisma.user.create({
      data: { email: 'test.sub@example.com', displayName: 'Sub User' },
    });
    const artist = await prisma.artist.create({ data: { name: 'Sub Artist' } });
    const track = await prisma.track.create({
      data: { title: 'Sub Track', artistId: artist.id, durationMs: 200000, status: 'READY' },
    });

    const sub = await prisma.subscription.create({
      data: { userId: user.id, planId: 'premium_individual', provider: 'DEV', status: 'ACTIVE' },
    });
    const play = await prisma.listeningHistory.create({
      data: { userId: user.id, trackId: track.id, progressMs: 200000, completed: true },
    });

    expect(sub.status).toBe('ACTIVE');
    expect(play.completed).toBe(true);

    const history = await prisma.user.findUnique({
      where: { id: user.id },
      include: { subscriptions: true, listeningHistory: { include: { track: true } } },
    });
    expect(history?.subscriptions).toHaveLength(1);
    expect(history?.listeningHistory[0].track.title).toBe('Sub Track');
  });
});
