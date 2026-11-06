import { z } from 'zod';
import { reforgerMod } from './reforger-host';

// The Reforger server configuration rules shared by the host tools and the
// panel, so a configuration template is checked with the same rules the host
// tools apply before they save a configuration.

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The connector's secret key rule. A key that ends with one of these names is hidden. */
export const reforgerSecretKey = /(?:password|secret|token|apiKey)$/i;

/** The placeholder the connector serves for a hidden secret and restores on save. */
export const reforgerKeepSecret = '[unchanged secret]';

/** Replace every non-empty secret string with the placeholder. */
export function redactReforgerConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactReforgerConfig);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        reforgerSecretKey.test(key) && typeof item === 'string' && item
          ? reforgerKeepSecret
          : redactReforgerConfig(item),
      ]),
    );
  return value;
}

/** Validate a Reforger server configuration. It returns warnings or throws. */
export function validateReforgerHostConfig(raw: unknown) {
  const config = object(raw),
    game = object(config.game),
    rcon = object(config.rcon),
    a2s = object(config.a2s);
  if (
    !Object.keys(config).length ||
    typeof game.name !== 'string' ||
    game.name.length < 1 ||
    game.name.length > 100
  )
    throw new Error('Configuration needs game.name (1–100 characters).');
  if (
    typeof game.scenarioId !== 'string' ||
    !/^\{[A-Fa-f0-9]{16}\}[^\r\n]{1,240}\.conf$/.test(game.scenarioId) ||
    game.scenarioId.includes('\0')
  )
    throw new Error('Use a native {WorkshopGUID} scenario .conf resource.');
  if (
    !Number.isInteger(game.maxPlayers) ||
    Number(game.maxPlayers) < 1 ||
    Number(game.maxPlayers) > 128
  )
    throw new Error('Player capacity must be 1–128.');
  const ports = [config.bindPort, a2s.port, rcon.port].filter(
    (value) => value !== undefined,
  );
  if (
    ports.some(
      (value) =>
        !Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535,
    ) ||
    new Set(ports).size !== ports.length
  )
    throw new Error(
      'Game, query and RCON UDP ports must be valid and distinct.',
    );
  if (
    Object.keys(rcon).length &&
    (typeof rcon.password !== 'string' ||
      !/^[\x21-\x7e]{3,512}$/.test(rcon.password) ||
      !['admin', 'monitor'].includes(String(rcon.permission)))
  )
    throw new Error('RCON needs a valid password and monitor/admin role.');
  if (game.mods !== undefined) {
    const mods = z.array(reforgerMod).max(300).parse(game.mods);
    if (new Set(mods.map((mod) => mod.modId)).size !== mods.length)
      throw new Error('Configuration contains duplicate Workshop IDs.');
  }
  const warnings = [] as string[];
  if (object(game.gameProperties).fastValidation !== true)
    warnings.push('Bohemia recommends fastValidation=true.');
  if (game.crossPlatform === true && game.supportedPlatforms !== undefined)
    warnings.push(
      'Bohemia recommends crossPlatform=true without supportedPlatforms.',
    );
  if (Array.isArray(game.mods) && game.mods.length)
    warnings.push(
      'Workshop download, dependencies and pin compatibility must be verified by the game on launch; no official metadata API is assumed.',
    );
  return warnings;
}
