// Phase 5 — API configuration.
// The backend base URL is injected at bundle time via the public env var
// EXPO_PUBLIC_API_URL (e.g. http://10.0.2.2:3000 for the Android emulator
// talking to a host-local API). Falls back to localhost for dev.

export function getApiBaseUrl(): string {
  const raw = process.env.EXPO_PUBLIC_API_URL;
  if (raw && raw.trim().length > 0) {
    return raw.trim().replace(/\/+$/, '');
  }
  return 'http://localhost:3000';
}
