// Phase 32 — minimal production observability without external
// dependencies. In-memory counters for the signals that matter on day one:
// traffic, auth failures, rate-limit hits, playback/download authorization,
// webhooks, and background processing failures.
//
// This is intentionally not Prometheus exposition format — a scraping
// endpoint can be added when the deployment has a metrics backend. The
// `/v1/metrics` route (registered in app.ts) exposes the snapshot as JSON
// and is gated to localhost/admin; see PRODUCTION-READINESS.md.

export interface MetricsSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  requests: { total: number; byStatus: Record<string, number> };
  authFailures: number;
  rateLimitHits: number;
  playbackSessionsCreated: number;
  playbackErrors: number;
  downloadAuthorizations: number;
  subscriptionWebhooks: { received: number; duplicates: number; failed: number };
  commerceWebhooks: { received: number; duplicates: number; failed: number };
  ingestionJobs: { succeeded: number; failed: number };
  royaltyRuns: { succeeded: number; failed: number };
  dbErrors: number;
  wsConnections: { current: number; total: number; errors: number };
}

class Metrics {
  private readonly startedAt = new Date();
  private requestsTotal = 0;
  private readonly requestsByStatus: Record<string, number> = {};
  private authFailures = 0;
  private rateLimitHits = 0;
  private playbackSessionsCreated = 0;
  private playbackErrors = 0;
  private downloadAuthorizations = 0;
  private readonly subscriptionWebhooks = { received: 0, duplicates: 0, failed: 0 };
  private readonly commerceWebhooks = { received: 0, duplicates: 0, failed: 0 };
  private readonly ingestionJobs = { succeeded: 0, failed: 0 };
  private readonly royaltyRuns = { succeeded: 0, failed: 0 };
  private dbErrors = 0;
  private wsCurrent = 0;
  private wsTotal = 0;
  private wsErrors = 0;

  recordRequest(status: number): void {
    this.requestsTotal += 1;
    const bucket = `${Math.floor(status / 100)}xx`;
    this.requestsByStatus[bucket] = (this.requestsByStatus[bucket] ?? 0) + 1;
  }
  recordAuthFailure(): void {
    this.authFailures += 1;
  }
  recordRateLimitHit(): void {
    this.rateLimitHits += 1;
  }
  recordPlaybackSessionCreated(): void {
    this.playbackSessionsCreated += 1;
  }
  recordPlaybackError(): void {
    this.playbackErrors += 1;
  }
  recordDownloadAuthorization(): void {
    this.downloadAuthorizations += 1;
  }
  recordSubscriptionWebhook(outcome: 'received' | 'duplicates' | 'failed'): void {
    this.subscriptionWebhooks[outcome] += 1;
  }
  recordCommerceWebhook(outcome: 'received' | 'duplicates' | 'failed'): void {
    this.commerceWebhooks[outcome] += 1;
  }
  recordIngestionJob(outcome: 'succeeded' | 'failed'): void {
    this.ingestionJobs[outcome] += 1;
  }
  recordRoyaltyRun(outcome: 'succeeded' | 'failed'): void {
    this.royaltyRuns[outcome] += 1;
  }
  recordDbError(): void {
    this.dbErrors += 1;
  }
  wsConnected(): void {
    this.wsCurrent += 1;
    this.wsTotal += 1;
  }
  wsDisconnected(): void {
    this.wsCurrent = Math.max(0, this.wsCurrent - 1);
  }
  wsError(): void {
    this.wsErrors += 1;
  }

  snapshot(): MetricsSnapshot {
    return {
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      requests: { total: this.requestsTotal, byStatus: { ...this.requestsByStatus } },
      authFailures: this.authFailures,
      rateLimitHits: this.rateLimitHits,
      playbackSessionsCreated: this.playbackSessionsCreated,
      playbackErrors: this.playbackErrors,
      downloadAuthorizations: this.downloadAuthorizations,
      subscriptionWebhooks: { ...this.subscriptionWebhooks },
      commerceWebhooks: { ...this.commerceWebhooks },
      ingestionJobs: { ...this.ingestionJobs },
      royaltyRuns: { ...this.royaltyRuns },
      dbErrors: this.dbErrors,
      wsConnections: { current: this.wsCurrent, total: this.wsTotal, errors: this.wsErrors },
    };
  }
}

/** Process-lifetime singleton. */
export const metrics = new Metrics();
