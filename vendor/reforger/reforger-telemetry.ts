import { promises as fs, constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  reforgerJournalPage,
  reforgerTelemetryEvent,
} from '../games/reforger-telemetry';

const wire = z
  .object({
    format: z.literal('warguardian.reforger-producer'),
    version: z.literal(1),
    // The engine can stringify its random nonce as a signed integer.
    // Stream IDs are opaque; preserve that source value instead of rewriting it.
    stream: z
      .string()
      .max(80)
      .regex(/^[0-9]+--?[0-9]+$/),
    sequence: z.number().int().positive(),
    sourceMode: z.enum(['authority', 'synthetic']).default('authority'),
    atUnixSeconds: z.number().int().min(1577836800),
    event: z.record(z.string(), z.unknown()),
  })
  .strict();
export function decodeReforgerProducer(input: unknown) {
  const value = wire.parse(input),
    raw = value.event,
    at = value.atUnixSeconds * 1000,
    id = `${value.stream}:${value.sequence}`;
  let event;
  if (raw.kind === 'player') {
    const kind =
      typeof raw.platformKind === 'string'
        ? raw.platformKind.toUpperCase()
        : '';
    const platform =
      kind === 'STEAM'
        ? 'steam'
        : kind.includes('XBOX')
          ? 'xbox'
          : ['PSN', 'PLAYSTATION', 'PS4', 'PS5'].includes(kind)
            ? 'playstation'
            : 'unknown';
    event = reforgerTelemetryEvent.parse({
      kind: 'player',
      id,
      at,
      player: raw.player,
      pingMs: raw.pingMs ?? null,
      platform,
      steamId: platform === 'steam' ? raw.platformId || null : null,
    });
  } else event = reforgerTelemetryEvent.parse({ ...raw, id, at });
  return {
    stream: value.stream,
    sequence: value.sequence,
    event,
    sourceMode: value.sourceMode,
  };
}
/** Fixed, root-validated profile path supplied by the controller. No arbitrary file API. */
export async function readReforgerJournal(
  path: string,
  offset: number,
  generation: string | null,
) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 104857600)
    throw new Error('Invalid telemetry cursor.');
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 104857600)
      throw new Error(
        'Telemetry file exceeds its 100 MiB limit. Archive acknowledged source records before resuming.',
      );
    const anchor = Buffer.alloc(Math.min(stat.size, 256));
    await file.read(anchor, 0, anchor.length, 0);
    // Include inode and the first source bytes; app restarts cannot advance a new file's cursor.
    const newline = anchor.indexOf(10);
    const fingerprint = createHash('sha256')
      .update(`${stat.dev}:${stat.ino}:`)
      .update(newline >= 0 ? anchor.subarray(0, newline + 1) : anchor)
      .digest('hex');
    const gap =
      offset > stat.size ||
      (offset > 0 && !!generation && generation !== fingerprint);
    let position = gap ? 0 : offset;
    const bytes = Buffer.alloc(Math.min(60000, stat.size - position));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
    const data = bytes.subarray(0, bytesRead),
      events: ReturnType<typeof decodeReforgerProducer>['event'][] = [];
    let stream: string | undefined,
      lastSequence: number | undefined,
      sourceMode: 'authority' | 'synthetic' | undefined;
    for (let start = 0; start < data.length;) {
      const end = data.indexOf(10, start);
      if (end < 0) {
        if (data.length === 60000 && start === 0)
          throw new Error(
            'A telemetry record exceeds 60 kB. Repair the telemetry file.',
          );
        break;
      }
      const line = new TextDecoder('utf-8', { fatal: true })
        .decode(data.subarray(start, end))
        .trim();
      if (!line) {
        position += end - start + 1;
        start = end + 1;
        continue;
      }
      const record = decodeReforgerProducer(JSON.parse(line));
      if (stream && stream !== record.stream) break;
      if (sourceMode && sourceMode !== record.sourceMode)
        throw new Error(
          'Telemetry stream mixes real and synthetic source labels. Repair the source.',
        );
      sourceMode = record.sourceMode;
      if (lastSequence !== undefined && record.sequence !== lastSequence + 1)
        throw new Error(
          'Telemetry file has a sequence gap or duplicate. No cursor was advanced.',
        );
      stream = record.stream;
      lastSequence = record.sequence;
      events.push(record.event);
      position += end - start + 1;
      start = end + 1;
      if (events.length >= 100) break;
    }
    return reforgerJournalPage.parse({
      generation: fingerprint,
      nextOffset: position,
      gap,
      batch: events.length
        ? {
            format: 'warguardian.reforger-telemetry',
            version: 1,
            provider: 'warguardian',
            providerVersion:
              sourceMode === 'synthetic'
                ? 'SYNTHETIC journal qualification 1.0.0'
                : 'WarGuardian authority producer 1.0.0',
            stream,
            events,
          }
        : null,
    });
  } finally {
    await file.close();
  }
}
