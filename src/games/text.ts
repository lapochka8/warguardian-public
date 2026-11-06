import { AgentError } from '../errors';

/** Limits are in Unicode code points and UTF-8 bytes. */
export type GameTextLimits = { maxChars: number; maxBytes: number };

/**
 * Control characters (U+0000 to U+001F and U+007F to U+009F), the line and
 * paragraph separators and unpaired surrogates. Any of them can end, split or
 * corrupt a command line.
 */
function forbiddenCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  );
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

export function invalidText(): AgentError {
  return new AgentError(
    400,
    'invalid-text',
    'The text cannot be sent to the game.',
  );
}

/**
 * Return the text unchanged when a game may send it. Text is never trimmed,
 * truncated or escaped, so the game receives exactly what was reviewed.
 */
export function validateGameText(text: string, limits: GameTextLimits): string {
  if (typeof text !== 'string' || !text.trim()) throw invalidText();
  let chars = 0;
  let bytes = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    chars += 1;
    bytes += utf8Length(codePoint);
    if (
      forbiddenCodePoint(codePoint) ||
      chars > limits.maxChars ||
      bytes > limits.maxBytes
    )
      throw invalidText();
  }
  return text;
}

const replacementCharacter = String.fromCodePoint(0xfffd);

/**
 * A line from a game server for the event feed: tabs become spaces, other
 * controls and separators are removed and an unpaired surrogate becomes
 * U+FFFD, so each UTF-16 unit takes at most three bytes in JSON. The line is
 * cut to `maxChars` UTF-16 units without splitting a character.
 */
export function feedText(text: string, maxChars: number): string {
  let result = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    const kept =
      codePoint === 0x09
        ? ' '
        : codePoint >= 0xd800 && codePoint <= 0xdfff
          ? replacementCharacter
          : forbiddenCodePoint(codePoint)
            ? ''
            : character;
    if (result.length + kept.length > maxChars) break;
    result += kept;
  }
  return result;
}

/**
 * Characters an Unreal Engine console may read as syntax: quotes and
 * backslashes change argument splitting, `;` and the backtick start another
 * statement, and some servers split one line into commands at `|`.
 */
export const unrealConsoleForbiddenText = /["\\;`|]/u;

export function validateUnrealText(
  text: string,
  limits: GameTextLimits,
): string {
  const valid = validateGameText(text, limits);
  if (unrealConsoleForbiddenText.test(valid)) throw invalidText();
  return valid;
}
