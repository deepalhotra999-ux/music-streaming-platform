/**
 * Phase 2 seed — royalty-free placeholder catalog only.
 * All artist/track names are fictional. Safe to re-run (upserts by unique key).
 */
import { PrismaClient, AlbumType, TrackStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // Genres
  const genreNames = ['Electronic', 'Ambient', 'Jazz', 'Rock', 'Hip-Hop', 'Classical'];
  const genres = await Promise.all(
    genreNames.map((name) =>
      prisma.genre.upsert({
        where: { name },
        update: {},
        create: { name, description: `Placeholder ${name.toLowerCase()} catalog` },
      }),
    ),
  );
  const genreByName = new Map(genres.map((g) => [g.name, g]));

  // Users
  const listener = await prisma.user.upsert({
    where: { email: 'mia.listener@example.com' },
    update: {},
    create: {
      email: 'mia.listener@example.com',
      displayName: 'Mia Listener',
      emailVerified: true,
      role: 'LISTENER',
      countryCode: 'CA',
    },
  });
  const producer = await prisma.user.upsert({
    where: { email: 'dev.producer@example.com' },
    update: {},
    create: {
      email: 'dev.producer@example.com',
      displayName: 'Dev Producer',
      emailVerified: true,
      role: 'ARTIST',
      countryCode: 'CA',
    },
  });

  // Artists + profiles
  const neon = await prisma.artist.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Neon Coastline',
      ownerUserId: producer.id,
      verified: true,
      profile: {
        create: {
          bio: 'Fictional synth duo crafting placeholder soundscapes for development.',
          website: 'https://example.com/neon-coastline',
        },
      },
    },
    include: { profile: true },
  });
  const paper = await prisma.artist.upsert({
    where: { id: '00000000-0000-0000-0000-000000000002' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000002',
      name: 'Paper Satellites',
      verified: false,
      profile: {
        create: { bio: 'Label-imported placeholder artist (no owner user).' },
      },
    },
    include: { profile: true },
  });

  // Albums
  const glassHorizon = await prisma.album.upsert({
    where: { id: '00000000-0000-0000-0000-000000000011' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000011',
      title: 'Glass Horizon',
      artistId: neon.id,
      albumType: AlbumType.ALBUM,
      releaseDate: new Date('2026-01-15'),
    },
  });
  const staticBloom = await prisma.album.upsert({
    where: { id: '00000000-0000-0000-0000-000000000012' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000012',
      title: 'Static Bloom',
      artistId: paper.id,
      albumType: AlbumType.SINGLE,
      releaseDate: new Date('2026-03-02'),
    },
  });

  // Tracks (fictional ISRCs — placeholder namespace)
  const trackDefs = [
    {
      title: 'Glass Horizon',
      albumId: glassHorizon.id,
      artistId: neon.id,
      n: 1,
      ms: 214000,
      isrc: 'QZ-DEV-26-00001',
      genre: 'Electronic',
    },
    {
      title: 'Tide Assembly',
      albumId: glassHorizon.id,
      artistId: neon.id,
      n: 2,
      ms: 187000,
      isrc: 'QZ-DEV-26-00002',
      genre: 'Ambient',
    },
    {
      title: 'Copper Skyline',
      albumId: glassHorizon.id,
      artistId: neon.id,
      n: 3,
      ms: 243000,
      isrc: 'QZ-DEV-26-00003',
      genre: 'Electronic',
    },
    {
      title: 'Static Bloom',
      albumId: staticBloom.id,
      artistId: paper.id,
      n: 1,
      ms: 198000,
      isrc: 'QZ-DEV-26-00004',
      genre: 'Rock',
    },
    {
      title: 'Paper Orbit',
      albumId: null,
      artistId: paper.id,
      n: null,
      ms: 176000,
      isrc: 'QZ-DEV-26-00005',
      genre: 'Jazz',
    },
    {
      title: 'Low Lantern',
      albumId: null,
      artistId: neon.id,
      n: null,
      ms: 221000,
      isrc: 'QZ-DEV-26-00006',
      genre: 'Ambient',
    },
  ];
  const tracks = [];
  for (const t of trackDefs) {
    const track = await prisma.track.upsert({
      where: { isrc: t.isrc },
      update: {},
      create: {
        title: t.title,
        albumId: t.albumId,
        artistId: t.artistId,
        durationMs: t.ms,
        trackNumber: t.n,
        isrc: t.isrc,
        status: TrackStatus.READY,
      },
    });
    const genre = genreByName.get(t.genre);
    if (genre) {
      await prisma.trackGenre.upsert({
        where: { trackId_genreId: { trackId: track.id, genreId: genre.id } },
        update: {},
        create: { trackId: track.id, genreId: genre.id },
      });
    }
    tracks.push(track);
  }

  // Playlist with ordered tracks
  const playlist = await prisma.playlist.upsert({
    where: { id: '00000000-0000-0000-0000-000000000021' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000021',
      title: "Mia's Focus Mix",
      description: 'Seeded placeholder playlist.',
      visibility: 'PRIVATE',
      ownerUserId: listener.id,
    },
  });
  await prisma.playlistTrack.deleteMany({ where: { playlistId: playlist.id } });
  for (const [i, track] of tracks.slice(0, 3).entries()) {
    await prisma.playlistTrack.create({
      data: {
        playlistId: playlist.id,
        trackId: track.id,
        position: i + 1,
        addedByUserId: listener.id,
      },
    });
  }

  // Like, follow, listening history
  await prisma.like.upsert({
    where: { userId_trackId: { userId: listener.id, trackId: tracks[0].id } },
    update: {},
    create: { userId: listener.id, trackId: tracks[0].id },
  });
  await prisma.follow.upsert({
    where: { userId_artistId: { userId: listener.id, artistId: neon.id } },
    update: {},
    create: { userId: listener.id, artistId: neon.id },
  });
  await prisma.listeningHistory.create({
    data: {
      userId: listener.id,
      trackId: tracks[1].id,
      progressMs: tracks[1].durationMs,
      completed: true,
    },
  });

  // Subscription (shape only — no payment processing; maps the legacy
  // Phase 2 seed value onto the Phase 18 plan catalog)
  await prisma.subscription.create({
    data: {
      userId: producer.id,
      planId: 'premium_individual',
      provider: 'DEV',
      status: 'ACTIVE',
      currentPeriodStart: new Date('2026-09-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    },
  });

  const counts = await Promise.all([
    prisma.user.count(),
    prisma.artist.count(),
    prisma.album.count(),
    prisma.track.count(),
    prisma.playlist.count(),
  ]);
  console.log(
    `Seed complete: ${counts[0]} users, ${counts[1]} artists, ${counts[2]} albums, ${counts[3]} tracks, ${counts[4]} playlists.`,
  );
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
