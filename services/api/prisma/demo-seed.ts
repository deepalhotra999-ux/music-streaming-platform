/**
 * LOCAL DEMO SEED — development only, never run against production.
 *
 * Builds a rich, deterministic demo dataset on top of the base seed
 * (`prisma db seed`). Creates three demo accounts with a documented
 * local-only password and enough content to walk through the full product:
 * listener library, artist dashboard, admin console, community, rooms,
 * commerce, and royalty transparency.
 *
 * ALL names are fictional. ALL audio is synthesized (see
 * `npm run audio:generate`). No copyrighted material.
 *
 * Demo credentials (LOCAL ONLY — the API refuses to boot these in
 * production; see loadConfig):
 *   Listener: demo.listener@example.local / Demo1234!
 *   Artist:   demo.artist@example.local   / Demo1234!
 *   Admin:    demo.admin@example.local    / Demo1234!
 *
 * Usage:
 *   npm run demo:seed   (runs base seed first, then this)
 *
 * Safe to re-run (upserts by unique key; find-first guards where no
 * unique constraint exists).
 */
import { PrismaClient, TrackStatus } from '@prisma/client';
import { hashPassword } from '../src/modules/auth/passwords.js';

const prisma = new PrismaClient();

// LOCAL DEMO ONLY — documented in docs/LOCAL-DEMO.md. Never use in production.
const DEMO_PASSWORD = 'Demo1234!';

async function main(): Promise<void> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // ------------------------------------------------------------------
  // Demo accounts
  // ------------------------------------------------------------------
  const listener = await prisma.user.upsert({
    where: { email: 'demo.listener@example.local' },
    update: { passwordHash, role: 'LISTENER', emailVerified: true },
    create: {
      email: 'demo.listener@example.local',
      displayName: 'Dana Listener',
      emailVerified: true,
      passwordHash,
      role: 'LISTENER',
      countryCode: 'CA',
    },
  });

  const artistUser = await prisma.user.upsert({
    where: { email: 'demo.artist@example.local' },
    update: { passwordHash, role: 'ARTIST', emailVerified: true },
    create: {
      email: 'demo.artist@example.local',
      displayName: 'Ari Demo',
      emailVerified: true,
      passwordHash,
      role: 'ARTIST',
      countryCode: 'CA',
    },
  });

  await prisma.user.upsert({
    where: { email: 'demo.admin@example.local' },
    update: { passwordHash, role: 'ADMIN', emailVerified: true },
    create: {
      email: 'demo.admin@example.local',
      displayName: 'Ada Admin',
      emailVerified: true,
      passwordHash,
      role: 'ADMIN',
      countryCode: 'CA',
    },
  });

  // ------------------------------------------------------------------
  // Demo artist (owned by the demo artist user)
  // ------------------------------------------------------------------
  const demoArtist = await prisma.artist.upsert({
    where: { id: '00000000-0000-0000-0000-000000000101' },
    update: { ownerUserId: artistUser.id, verified: true },
    create: {
      id: '00000000-0000-0000-0000-000000000101',
      name: 'Pixel Reverie',
      ownerUserId: artistUser.id,
      verified: true,
      profile: {
        create: {
          bio: 'Fictional demo artist. All tracks are synthesized placeholder audio.',
          website: 'https://example.local/pixel-reverie',
        },
      },
    },
  });

  // Demo album + READY tracks (guarantees the demo artist has playable content)
  const album = await prisma.album.upsert({
    where: { id: '00000000-0000-0000-0000-000000000102' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000102',
      title: 'Demo Frequencies',
      artistId: demoArtist.id,
      albumType: 'ALBUM',
      releaseDate: new Date('2026-01-15'),
    },
  });

  const trackTitles = [
    'Sine Sunrise',
    'Midnight Oscillator',
    'Harmonic Drift',
    'Static Bloom (Demo Mix)',
  ];
  const demoTracks = [];
  for (let i = 0; i < trackTitles.length; i++) {
    const track = await prisma.track.upsert({
      where: { isrc: `DEMO000${i + 1}000001` },
      update: { status: TrackStatus.READY },
      create: {
        title: trackTitles[i],
        artistId: demoArtist.id,
        albumId: album.id,
        trackNumber: i + 1,
        durationMs: 30000,
        isrc: `DEMO000${i + 1}000001`,
        status: TrackStatus.READY,
      },
    });
    demoTracks.push(track);
  }

  // ------------------------------------------------------------------
  // Listener library: playlist, likes, follows, history
  // ------------------------------------------------------------------
  const playlist = await prisma.playlist.upsert({
    where: { id: '00000000-0000-0000-0000-000000000103' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000103',
      title: 'Demo Drive Mix',
      description: 'A starter playlist for the local demo walkthrough.',
      visibility: 'PUBLIC',
      ownerUserId: listener.id,
    },
  });
  for (let i = 0; i < demoTracks.length; i++) {
    const existing = await prisma.playlistTrack.findFirst({
      where: { playlistId: playlist.id, trackId: demoTracks[i].id },
    });
    if (!existing) {
      await prisma.playlistTrack.create({
        data: {
          playlistId: playlist.id,
          trackId: demoTracks[i].id,
          position: i,
          addedByUserId: listener.id,
        },
      });
    }
  }

  // Collaborative playlist (demo walkthrough)
  await prisma.playlist.upsert({
    where: { id: '00000000-0000-0000-0000-000000000104' },
    update: { isCollaborative: true },
    create: {
      id: '00000000-0000-0000-0000-000000000104',
      title: 'Demo Collab Playlist',
      description: 'Collaborative playlist — invite the demo artist to add tracks.',
      visibility: 'PUBLIC',
      ownerUserId: listener.id,
      isCollaborative: true,
    },
  });

  for (const track of demoTracks.slice(0, 2)) {
    await prisma.like.upsert({
      where: { userId_trackId: { userId: listener.id, trackId: track.id } },
      update: {},
      create: { userId: listener.id, trackId: track.id },
    });
  }
  await prisma.follow.upsert({
    where: {
      userId_artistId: { userId: listener.id, artistId: demoArtist.id },
    },
    update: {},
    create: { userId: listener.id, artistId: demoArtist.id },
  });

  // Listening history (powers Discover recommendations in the demo)
  const historyCount = await prisma.listeningHistory.count({
    where: { userId: listener.id },
  });
  if (historyCount === 0) {
    for (let i = 0; i < demoTracks.length; i++) {
      await prisma.listeningHistory.create({
        data: {
          userId: listener.id,
          trackId: demoTracks[i].id,
          playedAt: new Date(Date.now() - (demoTracks.length - i) * 3600_000),
          completed: true,
        },
      });
    }
  }

  // ------------------------------------------------------------------
  // Community: artist post + listener comment
  // ------------------------------------------------------------------
  const post = await prisma.artistPost.upsert({
    where: { id: '00000000-0000-0000-0000-000000000105' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000105',
      artistId: demoArtist.id,
      authorUserId: artistUser.id,
      body: 'Welcome to the local demo! This is a fictional community post from Pixel Reverie. Our synthesized single "Sine Sunrise" is streaming now in the demo catalog.',
      trackId: demoTracks[0].id,
    },
  });
  const commentCount = await prisma.postComment.count({
    where: { postId: post.id },
  });
  if (commentCount === 0) {
    await prisma.postComment.create({
      data: {
        postId: post.id,
        authorUserId: listener.id,
        body: 'Love the demo mix! The full player UI is great.',
      },
    });
  }

  // ------------------------------------------------------------------
  // Listening room (demo walkthrough)
  // ------------------------------------------------------------------
  const room = await prisma.listeningRoom.upsert({
    where: { id: '00000000-0000-0000-0000-000000000106' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000106',
      hostUserId: listener.id,
      visibility: 'PRIVATE',
    },
  });
  for (let i = 0; i < demoTracks.length; i++) {
    const existing = await prisma.listeningRoomQueueItem.findFirst({
      where: { roomId: room.id, trackId: demoTracks[i].id },
    });
    if (!existing) {
      await prisma.listeningRoomQueueItem.create({
        data: {
          roomId: room.id,
          trackId: demoTracks[i].id,
          position: i,
          addedByUserId: listener.id,
        },
      });
    }
  }

  // ------------------------------------------------------------------
  // Commerce: artist store + products (mock provider at checkout)
  // ------------------------------------------------------------------
  const store = await prisma.artistStore.upsert({
    where: { artistId: demoArtist.id },
    update: {},
    create: {
      artistId: demoArtist.id,
      name: 'Pixel Reverie Merch',
    },
  });
  let product = await prisma.product.findFirst({
    where: { storeId: store.id, title: 'Demo Tee' },
  });
  if (!product) {
    product = await prisma.product.create({
      data: {
        storeId: store.id,
        artistId: demoArtist.id,
        title: 'Demo Tee',
        description: 'Fictional demo merchandise. Checkout uses the mock payment provider.',
        type: 'APPAREL',
        status: 'ACTIVE',
        priceCents: 2500,
        currency: 'USD',
        sku: 'DEMO-TEE-M',
      },
    });
  }
  let variant = await prisma.productVariant.findFirst({
    where: { productId: product.id, name: 'Size M' },
  });
  if (!variant) {
    variant = await prisma.productVariant.create({
      data: {
        productId: product.id,
        name: 'Size M',
        priceCents: 2500,
        currency: 'USD',
        sortOrder: 0,
      },
    });
  }
  const inv = await prisma.inventoryItem.findFirst({
    where: { productId: product.id, variantId: variant.id },
  });
  if (!inv) {
    await prisma.inventoryItem.create({
      data: {
        productId: product.id,
        variantId: variant.id,
        quantityAvailable: 100,
      },
    });
  }

  // ------------------------------------------------------------------
  // Subscription: active DEV subscription for the listener
  // ------------------------------------------------------------------
  const plan = await prisma.plan.upsert({
    where: { id: 'demo-premium' },
    update: {},
    create: {
      id: 'demo-premium',
      name: 'Demo Premium',
      planType: 'INDIVIDUAL',
      devProductId: 'dev.demo.premium.monthly',
      active: true,
    },
  });
  await prisma.subscription.upsert({
    where: { id: '00000000-0000-0000-0000-000000000108' },
    update: { status: 'ACTIVE' },
    create: {
      id: '00000000-0000-0000-0000-000000000108',
      userId: listener.id,
      planId: plan.id,
      provider: 'DEV',
      status: 'ACTIVE',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600_000),
    },
  });

  console.log('Demo seed complete:');
  console.log('  Listener: demo.listener@example.local / Demo1234!');
  console.log('  Artist:   demo.artist@example.local   / Demo1234!');
  console.log('  Admin:    demo.admin@example.local    / Demo1234!');
  console.log(`  Artist "${demoArtist.name}" with ${demoTracks.length} READY tracks.`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
