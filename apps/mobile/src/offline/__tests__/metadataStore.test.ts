// Phase 25 — AsyncStorage download metadata: display/state only, never
// authorization. Crash recovery must land interrupted work in safe states.

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getDownloadRecord,
  listDownloadIds,
  newDownloadRecord,
  recoverInterruptedDownloads,
  removeDownloadRecord,
  saveDownloadRecord,
  updateDownloadRecord,
} from '../metadataStore';

const META = { title: 'T', artistName: 'A', albumTitle: null, durationMs: 180000 };

function resetStorage(): void {
  (AsyncStorage as unknown as { __reset: () => void }).__reset();
}

beforeEach(() => {
  resetStorage();
});

describe('metadataStore', () => {
  it('saves, lists, updates, and removes records', async () => {
    await saveDownloadRecord(newDownloadRecord('t1', META));
    await saveDownloadRecord(newDownloadRecord('t2', META));
    expect(await listDownloadIds()).toEqual(expect.arrayContaining(['t1', 't2']));

    const updated = await updateDownloadRecord('t1', { status: 'downloading', bytesWritten: 42 });
    expect(updated?.status).toBe('downloading');
    expect(updated?.bytesWritten).toBe(42);
    expect(updated?.updatedAt).toBeDefined();

    await removeDownloadRecord('t1');
    expect(await getDownloadRecord('t1')).toBeNull();
    expect(await listDownloadIds()).not.toContain('t1');
  });

  it('updateDownloadRecord returns null for unknown tracks', async () => {
    expect(await updateDownloadRecord('nope', { status: 'failed' })).toBeNull();
  });

  it('tolerates corrupt index JSON', async () => {
    await AsyncStorage.setItem('offline.downloads.index.v1', '[[[broken');
    expect(await listDownloadIds()).toEqual([]);
  });

  it('recovers interrupted downloads: downloading -> paused, verifying -> queued', async () => {
    await saveDownloadRecord({
      ...newDownloadRecord('a', META),
      status: 'downloading',
      resumeSegment: 3,
    });
    await saveDownloadRecord({ ...newDownloadRecord('b', META), status: 'verifying' });
    await saveDownloadRecord({ ...newDownloadRecord('c', META), status: 'complete' });
    await saveDownloadRecord({ ...newDownloadRecord('d', META), status: 'failed' });

    const recovered = await recoverInterruptedDownloads();
    expect(recovered).toHaveLength(2);
    expect((await getDownloadRecord('a'))?.status).toBe('paused');
    // Resume progress is preserved so completed segments are not re-fetched.
    expect((await getDownloadRecord('a'))?.resumeSegment).toBe(3);
    expect((await getDownloadRecord('b'))?.status).toBe('queued');
    expect((await getDownloadRecord('c'))?.status).toBe('complete');
    expect((await getDownloadRecord('d'))?.status).toBe('failed');
  });
});
