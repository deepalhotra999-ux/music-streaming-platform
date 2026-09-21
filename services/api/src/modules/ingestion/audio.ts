// Phase 14 — artist audio ingestion. Uploaded-file validation.
//
// The client-declared MIME type / filename extension is never trusted:
// the format is determined by sniffing magic bytes, and the file must
// additionally survive an ffprobe decode check before it reaches storage.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

export interface AudioFormat {
  /** Server-assigned extension, derived from magic bytes (not the client). */
  ext: 'mp3' | 'wav' | 'flac' | 'm4a' | 'ogg';
  contentType: string;
  label: string;
}

const MP3: AudioFormat = { ext: 'mp3', contentType: 'audio/mpeg', label: 'MP3' };
const WAV: AudioFormat = { ext: 'wav', contentType: 'audio/wav', label: 'WAV' };
const FLAC: AudioFormat = { ext: 'flac', contentType: 'audio/flac', label: 'FLAC' };
const M4A: AudioFormat = { ext: 'm4a', contentType: 'audio/mp4', label: 'M4A/AAC' };
const OGG: AudioFormat = { ext: 'ogg', contentType: 'audio/ogg', label: 'Ogg Vorbis' };

/** The clearly defined set of accepted upload formats. */
export const SUPPORTED_FORMATS: readonly AudioFormat[] = [MP3, WAV, FLAC, M4A, OGG];

export const SUPPORTED_FORMAT_LABELS = SUPPORTED_FORMATS.map((f) => f.label).join(', ');

/**
 * Identify an audio format from magic bytes. Returns null when the content
 * is not one of the supported formats. Reads only the header — cheap enough
 * to run before any heavier validation.
 */
export function sniffAudioFormat(header: Buffer): AudioFormat | null {
  if (header.length < 12) return null;
  const ascii = (start: number, end: number): string =>
    header.subarray(start, end).toString('ascii');
  if (ascii(0, 4) === 'fLaC') return FLAC;
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return WAV;
  if (ascii(0, 4) === 'OggS') return OGG;
  if (ascii(4, 8) === 'ftyp') return M4A;
  if (ascii(0, 3) === 'ID3') return MP3;
  // MPEG audio / ADTS frame sync: 0xFF followed by 3 set bits.
  if (header[0] === 0xff && (header[1] & 0xe0) === 0xe0) return MP3;
  return null;
}

export async function sniffFileFormat(filePath: string): Promise<AudioFormat | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(filePath, 'r');
    const { buffer } = await handle.read(Buffer.alloc(64), 0, 64, 0);
    return sniffAudioFormat(buffer);
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

export interface ProbedAudio {
  durationSeconds: number;
  codecName: string;
}

/**
 * Verify the file is genuinely decodable audio: ffprobe must find an audio
 * stream with a positive duration. Throws a client-safe Error otherwise
 * (ffprobe's stderr never reaches the caller).
 */
export async function probeAudio(filePath: string): Promise<ProbedAudio> {
  let raw: string;
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-show_entries',
        'format=duration:stream=codec_type,codec_name',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    raw = stdout;
  } catch {
    throw new Error(
      'The uploaded file is not valid audio. Supported formats: ' +
        `${SUPPORTED_FORMAT_LABELS}.`,
    );
  }
  let parsed: {
    streams?: Array<{ codec_type?: string; codec_name?: string }>;
    format?: { duration?: string };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error('The uploaded file could not be read as audio.');
  }
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');
  const durationSeconds = Number(parsed.format?.duration);
  if (!audioStream || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(
      'The uploaded file contains no playable audio. Supported formats: ' +
        `${SUPPORTED_FORMAT_LABELS}.`,
    );
  }
  return { durationSeconds, codecName: audioStream.codec_name ?? 'unknown' };
}
