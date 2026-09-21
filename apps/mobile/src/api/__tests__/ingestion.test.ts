// Phase 14 — ingestion API wrappers + ApiClient.upload unit tests.
// No network: the client is injected with a stub fetch / mock methods.

import { ApiClient, ApiError } from '../client';
import { getAudioStatus, retryTrackAudio, uploadTrackAudio } from '../ingestion';

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function makeFetch(responses: Array<ReturnType<typeof jsonResponse> | Error>) {
  const calls: { url: string; init: { method?: string; headers?: Record<string, string>; body?: unknown } }[] =
    [];
  const fetchFn = jest.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

describe('ApiClient.upload', () => {
  it('sends the bearer token and never sets Content-Type (fetch adds the boundary)', async () => {
    const { fetchFn, calls } = makeFetch([jsonResponse(202, { trackId: 't1', audioStatus: 'PENDING' })]);
    const client = new ApiClient({
      baseUrl: 'http://api.test/',
      fetchFn,
      getAccessToken: () => 'access-123',
    });

    const formData = new FormData();
    formData.append('audio', 'fake-bytes');
    await client.upload('/v1/tracks/t1/audio', formData);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://api.test/v1/tracks/t1/audio');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers?.Authorization).toBe('Bearer access-123');
    expect(calls[0].init.headers?.['Content-Type']).toBeUndefined();
    expect(calls[0].init.body).toBe(formData);
  });

  it('retries once with a refreshed token after a 401, then succeeds', async () => {
    const { fetchFn, calls } = makeFetch([
      jsonResponse(401, { title: 'Unauthorized', status: 401 }),
      jsonResponse(202, { trackId: 't1', audioStatus: 'PENDING' }),
    ]);
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetchFn,
      getAccessToken: () => 'stale-token',
      onTokenRefresh: async () => 'fresh-token',
    });

    const result = await client.upload<{ audioStatus: string }>('/v1/tracks/t1/audio', new FormData());

    expect(result.audioStatus).toBe('PENDING');
    expect(calls).toHaveLength(2);
    expect(calls[0].init.headers?.Authorization).toBe('Bearer stale-token');
    expect(calls[1].init.headers?.Authorization).toBe('Bearer fresh-token');
  });

  it('throws the RFC 7807 problem when the refresh does not help (single retry only)', async () => {
    const { fetchFn, calls } = makeFetch([
      jsonResponse(401, { title: 'Unauthorized', status: 401 }),
      jsonResponse(401, { title: 'Unauthorized', status: 401, detail: 'Token revoked.' }),
    ]);
    const client = new ApiClient({
      baseUrl: 'http://api.test',
      fetchFn,
      getAccessToken: () => 'stale-token',
      onTokenRefresh: async () => 'fresh-token',
    });

    const error = await client.upload('/v1/tracks/t1/audio', new FormData()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect((error as ApiError).detail).toBe('Token revoked.');
    expect(calls).toHaveLength(2); // no endless retry loop
  });

  it('surfaces server validation problems (415/422/413/409) as ApiError', async () => {
    const { fetchFn } = makeFetch([
      jsonResponse(415, {
        title: 'Unsupported Media Type',
        status: 415,
        detail: 'Unsupported audio format. Supported formats: MP3, WAV, FLAC, M4A/AAC.',
      }),
    ]);
    const client = new ApiClient({ baseUrl: 'http://api.test', fetchFn });

    const error = await client.upload('/v1/tracks/t1/audio', new FormData()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(415);
    expect((error as ApiError).detail).toContain('Unsupported audio format');
  });
});

describe('ingestion wrappers', () => {
  function mockClient() {
    return {
      upload: jest.fn(async () => ({ trackId: 't1', audioStatus: 'PENDING', audioError: null, audioReadyAt: null })),
      get: jest.fn(async () => ({ trackId: 't1', audioStatus: 'READY', audioError: null, audioReadyAt: '2026-09-21T00:00:00.000Z' })),
      post: jest.fn(async () => ({ trackId: 't1', audioStatus: 'PENDING', audioError: null, audioReadyAt: null })),
    };
  }

  it('uploadTrackAudio posts multipart field "audio" to the track audio endpoint', async () => {
    const client = mockClient() as unknown as ApiClient;
    const appendSpy = jest.spyOn(FormData.prototype, 'append');

    await uploadTrackAudio(client, 'track-1', { uri: 'file:///cache/a.wav', name: 'a.wav', mimeType: 'audio/wav' });

    expect(client.upload).toHaveBeenCalledTimes(1);
    const [path, formData] = (client.upload as jest.Mock).mock.calls[0] as [string, FormData];
    expect(path).toBe('/v1/tracks/track-1/audio');
    expect(formData).toBeInstanceOf(FormData);
    expect(appendSpy).toHaveBeenCalledWith(
      'audio',
      expect.objectContaining({ uri: 'file:///cache/a.wav', name: 'a.wav', type: 'audio/wav' }),
    );
    appendSpy.mockRestore();
  });

  it('getAudioStatus GETs the status endpoint', async () => {
    const client = mockClient() as unknown as ApiClient;
    const status = await getAudioStatus(client, 'track-1');
    expect(client.get).toHaveBeenCalledWith('/v1/tracks/track-1/audio');
    expect(status.audioStatus).toBe('READY');
  });

  it('retryTrackAudio POSTs the retry endpoint', async () => {
    const client = mockClient() as unknown as ApiClient;
    const status = await retryTrackAudio(client, 'track-1');
    expect(client.post).toHaveBeenCalledWith('/v1/tracks/track-1/audio/retry');
    expect(status.audioStatus).toBe('PENDING');
  });
});
