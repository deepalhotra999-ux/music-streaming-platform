// Phase 14 — artist audio ingestion. In-process job queue.
//
// Transcoding is CPU-bound and unbounded concurrency would thrash the box,
// so ingestion jobs run strictly sequentially. The queue is a promise
// chain: enqueue() appends a job, never duplicates a track already queued,
// and a throwing job can never wedge the chain (processTrackAudio also
// catches internally; this is belt-and-braces).
//
// This is deliberately in-process, not a distributed queue: deployments run
// a single API instance. If the API ever scales horizontally, this module
// is the seam to replace — the DB claim (PENDING -> PROCESSING) already
// makes cross-instance processing safe.

export type ProcessFn = (trackId: string) => Promise<void>;

export class IngestionQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly queued = new Set<string>();

  constructor(private readonly process: ProcessFn) {}

  /** Enqueue a track for processing. No-op when already queued. */
  enqueue(trackId: string): void {
    if (this.queued.has(trackId)) return;
    this.queued.add(trackId);
    const run = this.tail.then(async () => {
      try {
        await this.process(trackId);
      } finally {
        this.queued.delete(trackId);
      }
    });
    // A rejected job must not break the chain for later jobs.
    this.tail = run.catch(() => {});
  }

  /** Resolves when all currently enqueued jobs have settled. */
  onIdle(): Promise<void> {
    return this.tail;
  }

  get pendingCount(): number {
    return this.queued.size;
  }
}
