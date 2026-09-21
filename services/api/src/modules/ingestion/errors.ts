// Phase 14 — ingestion pipeline errors.
//
// Every failure in the pipeline carries a machine code plus a client-safe
// message. The message is what the artist sees (and what audioError stores);
// the original cause stays in server logs only.

export type IngestionErrorCode =
  | 'invalid-audio'
  | 'transcode-failed'
  | 'validation-failed'
  | 'storage-error'
  | 'source-missing';

export class IngestionError extends Error {
  readonly code: IngestionErrorCode;
  /** Internal cause for server logs; never returned to clients. */
  readonly cause_: unknown;

  constructor(code: IngestionErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'IngestionError';
    this.code = code;
    this.cause_ = cause;
  }
}

export function isIngestionError(err: unknown): err is IngestionError {
  return err instanceof IngestionError;
}
