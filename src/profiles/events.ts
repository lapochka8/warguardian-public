import { randomBytes } from 'node:crypto';
import { nativeCursor, nativeFeedMaxItems } from '../protocol';

/** 12 random bytes in base64url, unique per buffer. */
const streamLength = 16;

/** The bytes an item adds to a JSON page: its JSON text and a comma. */
function jsonBytes(item: object): number {
  return Buffer.byteLength(JSON.stringify(item)) + 1;
}

/**
 * A bounded ring of items with increasing sequence numbers. The cursor is
 * the buffer's stream ID followed by the next sequence number, so a cursor
 * from an earlier agent process restarts at the oldest kept item. Items are
 * sized by their JSON bytes, the form in which a page reaches WarGuardian.
 */
export class EventBuffer<T extends object> {
  readonly stream = randomBytes(12).toString('base64url');
  readonly #maxItems: number;
  readonly #maxBytes: number;
  #items: { seq: number; item: T; bytes: number }[] = [];
  #bytes = 0;
  #next = 1;

  constructor(options: { maxItems: number; maxBytes: number }) {
    this.#maxItems = options.maxItems;
    this.#maxBytes = options.maxBytes;
  }

  push(item: T): void {
    const bytes = jsonBytes(item);
    this.#items.push({ seq: this.#next, item, bytes });
    this.#next += 1;
    this.#bytes += bytes;
    while (this.#items.length > this.#maxItems || this.#bytes > this.#maxBytes)
      this.#bytes -= this.#items.shift()!.bytes;
  }

  /**
   * Items after the cursor, up to `limit` items and `maxBytes` bytes of
   * JSON. `dropped` counts items after the cursor that the buffer no longer
   * holds.
   */
  read(
    cursor: string | null,
    limit = nativeFeedMaxItems,
    maxBytes = 512 * 1024,
  ): { cursor: string; items: T[]; dropped: number } {
    const oldest = this.#items[0]?.seq ?? this.#next;
    let from = oldest;
    let dropped = 0;
    if (
      cursor &&
      nativeCursor.safeParse(cursor).success &&
      cursor.slice(0, streamLength) === this.stream &&
      /^\d{1,15}$/.test(cursor.slice(streamLength))
    ) {
      const wanted = Number(cursor.slice(streamLength));
      if (wanted <= this.#next) {
        dropped = Math.max(0, oldest - wanted);
        from = Math.max(wanted, oldest);
      }
    }
    const items: T[] = [];
    let next = from;
    let bytes = 0;
    for (const entry of this.#items) {
      if (entry.seq < from) continue;
      if (
        items.length >= limit ||
        (items.length && bytes + entry.bytes > maxBytes)
      )
        break;
      items.push(entry.item);
      bytes += entry.bytes;
      next = entry.seq + 1;
    }
    return { cursor: `${this.stream}${next}`, items, dropped };
  }
}

/** The `cursor` query value of a GET path, or null. */
export function cursorOf(path: string): string | null {
  const url = new URL(path, 'http://agent.invalid');
  return url.searchParams.get('cursor');
}
