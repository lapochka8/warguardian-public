import { z } from 'zod';
import {
  reforgerModpack,
  reforgerModpackReport,
  reforgerWorkshopSearch,
  reforgerWorkshopDetail,
  reforgerServerSearch,
  reforgerServerMods,
  reforgerWorkshopVersion,
} from '../games/reforger-host';
const id = z
  .string()
  .regex(/^[a-f0-9]{16}$/i)
  .transform((value) => value.toUpperCase());
const preview = z.object({
  id,
  name: z.string().max(160),
  version: z.string().max(64),
  gameVersion: z.string().max(64).optional(),
  size: z.number().nonnegative().optional(),
  author: z.string().max(300).optional(),
  summary: z.string().max(10000).optional(),
});
const dependency = z.object({
  id,
  name: z.string().max(160).optional(),
  version: z.string().max(64).optional(),
});
const detail = z.object({
  status: z.literal('success'),
  mod: preview.extend({
    private: z.boolean(),
    obsolete: z.boolean(),
    dependencies: z.array(dependency).max(300).default([]),
    dependencyCount: z.number().int().nonnegative(),
  }),
});
const versionDetail = z.object({
  status: z.literal('success'),
  data: z.object({
    modId: id,
    version: z.string().max(64),
    published: z.boolean(),
    approved: z.boolean(),
    gameVersion: z.string().max(64).optional(),
    dependencies: z.array(dependency).max(300).default([]),
    dependencyCount: z.number().int().nonnegative(),
  }),
});

/** Public cached metadata only. It is never an ownership/moderation authority. */
export function createReforgerWorkshopClient(
  options: { fetcher?: typeof fetch; spacingMs?: number } = {},
) {
  const fetcher = options.fetcher ?? fetch,
    cache = new Map<string, { at: number; data: unknown }>(),
    pending = new Map<string, Promise<unknown>>();
  let queue = Promise.resolve(),
    nextAt = 0,
    blockedUntil = 0;
  const stopped = new AbortController();
  async function request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    if (stopped.signal.aborted)
      throw new Error(
        'Community metadata job cancelled. No partial pack was saved.',
      );
    const found = cache.get(path);
    if (found && Date.now() - found.at < 600000)
      return schema.parse(found.data);
    const active = pending.get(path);
    if (active) return schema.parse(await active);
    const work = queue.then(async () => {
      if (Date.now() < blockedUntil)
        throw new Error(
          'Community Workshop metadata is rate-limited. Retry after its provider cooldown; the game is unchanged.',
        );
      const wait = Math.max(0, nextAt - Date.now());
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      nextAt = Date.now() + (options.spacingMs ?? 2200);
      const response = await fetcher(
        `https://api.reforgermods.net/v2/${path}`,
        {
          redirect: 'error',
          signal: AbortSignal.any([AbortSignal.timeout(8000), stopped.signal]),
          headers: {
            Accept: 'application/json',
            'User-Agent': 'WarGuardian-Reforger/1',
          },
        },
      );
      if (response.status === 429 || response.status === 503) {
        const retry = Number(response.headers.get('retry-after'));
        blockedUntil =
          Date.now() +
          Math.min(
            86400000,
            Math.max(60000, Number.isFinite(retry) ? retry * 1000 : 60000),
          );
        throw new Error(
          'Community Workshop metadata is temporarily unavailable or rate-limited. No partial dependency set was saved.',
        );
      }
      if (!response.ok)
        throw new Error(
          `Community Workshop metadata request failed (${response.status}). No partial dependency set was saved.`,
        );
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Empty Workshop metadata reply.');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 2097152) {
          await reader.cancel();
          throw new Error('Workshop metadata exceeds the response limit.');
        }
        chunks.push(part.value);
      }
      if (response.headers.get('x-cache')?.toUpperCase() === 'STALE')
        throw new Error(
          'The community provider returned stale metadata. Review the Workshop directly; no dependency validation was saved.',
        );
      const result = schema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      cache.set(path, { at: Date.now(), data: result });
      while (cache.size > 128) cache.delete(cache.keys().next().value!);
      return result;
    });
    queue = work.then(
      () => {},
      () => {},
    );
    pending.set(path, work);
    try {
      return await work;
    } finally {
      pending.delete(path);
    }
  }
  return {
    close() {
      stopped.abort();
    },
    async search(text: string, page = 1, sort = 'popularity') {
      page = z.number().int().min(1).max(10000).parse(page);
      sort = z
        .enum(['popularity', 'newest', 'recently-updated', 'name'])
        .parse(sort);
      text = text.trim().slice(0, 100);
      if (!text)
        return reforgerWorkshopSearch.parse({
          provider: 'reforgermods.net',
          fetchedAt: null,
          mods: [],
        });
      const path = `mods?search=${encodeURIComponent(text)}&page=${page}&sort=${sort}`;
      const response = await request(
        path,
        z.object({
          status: z.literal('success'),
          meta: z
            .object({ totalPages: z.number().int().nonnegative() })
            .optional(),
          data: z.array(preview).max(100),
        }),
      );
      return reforgerWorkshopSearch.parse({
        provider: 'reforgermods.net',
        fetchedAt: cache.get(path)?.at ?? Date.now(),
        mods: response.data.slice(0, 16),
        page,
        totalPages: response.meta?.totalPages ?? null,
      });
    },
    async servers(text: string) {
      text = text.trim().slice(0, 100);
      if (!text)
        return reforgerServerSearch.parse({
          provider: 'reforgermods.net',
          fetchedAt: Date.now(),
          servers: [],
        });
      const path = `servers?search=${encodeURIComponent(text)}&perPage=25&hasMods=true&includeOffline=true`;
      const response = await request(
        path,
        z.object({
          status: z.literal('success'),
          data: z
            .array(
              z.object({
                id: z.uuid(),
                name: z.string(),
                scenarioName: z.string().nullish(),
                gameVersion: z.string().nullish(),
                players: z.number().nullish(),
                maxPlayers: z.number().nullish(),
                modCount: z.number().nullish(),
                region: z.string().nullish(),
                online: z.boolean().nullish(),
              }),
            )
            .max(500),
        }),
      );
      return reforgerServerSearch.parse({
        provider: 'reforgermods.net',
        fetchedAt: cache.get(path)?.at ?? Date.now(),
        servers: response.data.slice(0, 25).map((server) => ({
          id: server.id,
          name: server.name.slice(0, 200),
          scenarioName: server.scenarioName?.slice(0, 200) ?? null,
          gameVersion: server.gameVersion?.slice(0, 64) ?? null,
          players: server.players ?? null,
          maxPlayers: server.maxPlayers ?? null,
          modCount: server.modCount ?? null,
          region: server.region?.slice(0, 64) ?? null,
          online: server.online ?? null,
        })),
      });
    },
    async serverMods(rawId: string) {
      const serverId = z.uuid().parse(rawId),
        path = `servers/${serverId}/mods?sizes=false`;
      const response = await request(
        path,
        z.object({
          status: z.literal('success'),
          count: z.number().int().nonnegative().optional(),
          data: z
            .array(
              z.object({
                id,
                name: z.string(),
                version: z.string().nullish(),
              }),
            )
            .max(300),
        }),
      );
      return reforgerServerMods.parse({
        provider: 'reforgermods.net',
        fetchedAt: cache.get(path)?.at ?? Date.now(),
        serverId,
        count: response.count ?? response.data.length,
        mods: response.data.map((mod) => ({
          modId: mod.id,
          name: mod.name.slice(0, 160),
          version: mod.version?.slice(0, 64) ?? null,
        })),
      });
    },
    async inspect(rawId: string) {
      const modId = id.parse(rawId),
        mod = (await request(`mods/${modId}`, detail)).mod,
        history = await request(
          `mods/${modId}/versions`,
          z.object({
            status: z.literal('success'),
            data: z.object({
              modId: id,
              versions: z.array(reforgerWorkshopVersion).max(300),
            }),
          }),
        );
      if (mod.id !== modId || history.data.modId !== modId)
        throw new Error('Workshop metadata returned a different mod identity.');
      return reforgerWorkshopDetail.parse({
        provider: 'reforgermods.net',
        fetchedAt: cache.get(`mods/${modId}`)?.at ?? Date.now(),
        mod,
        versions: history.data.versions,
      });
    },
    async resolve(raw: z.infer<typeof reforgerModpack>) {
      const pack = reforgerModpack.parse(raw),
        entries = new Map(pack.mods.map((mod) => [mod.modId, mod])),
        roots = pack.mods.filter(
          (mod) => mod.enabled !== false && mod.origin !== 'dependency',
        ),
        visiting = new Set<string>(),
        finished = new Set<string>(),
        selected = new Map<string, string>(),
        requirements = new Map<string, string>(),
        mods: z.infer<typeof reforgerModpack>['mods'] = [],
        warnings: string[] = [],
        edges: z.infer<typeof reforgerModpackReport>['edges'] = [],
        versions: z.infer<typeof reforgerModpackReport>['versions'] = [];
      const deadline = Date.now() + 600000;
      async function visit(rawId: string, requiredVersion?: string) {
        const modId = id.parse(rawId),
          root = entries.get(modId);
        if (root?.enabled === false)
          throw new Error(
            `Required dependency ${modId} is disabled. Enable it or remove its dependents; no pack was changed.`,
          );
        const explicitPin =
          root?.origin === 'dependency' ? undefined : root?.version;
        const pin = explicitPin || requiredVersion;
        if (requiredVersion) {
          const prior = requirements.get(modId);
          if (
            (prior && prior !== requiredVersion) ||
            (explicitPin && explicitPin !== requiredVersion)
          )
            throw new Error(
              `Conflicting requested versions for ${modId}: ${prior || explicitPin} and ${requiredVersion}. Review the pins; no pack was changed.`,
            );
          requirements.set(modId, requiredVersion);
        }
        if (finished.has(modId)) {
          if (pin && selected.get(modId) !== pin)
            throw new Error(
              `Conflicting requested versions for ${modId}. Pin this dependency explicitly and resolve again; no pack was changed.`,
            );
          return;
        }
        if (visiting.has(modId))
          throw new Error(
            'The community metadata contains a dependency cycle. No pack was changed.',
          );
        if (visiting.size + finished.size >= 100 || Date.now() > deadline)
          throw new Error(
            'Dependency resolution exceeds 100 mods or ten minutes. No partial pack was saved.',
          );
        visiting.add(modId);
        const latest = (await request(`mods/${modId}`, detail)).mod;
        if (latest.id !== modId || latest.private || latest.obsolete)
          throw new Error(
            `Workshop item ${modId} is private, obsolete or inconsistent. No partial pack was saved.`,
          );
        let dependencies = latest.dependencies,
          gameVersion = latest.gameVersion;
        if (pin) {
          if (!/^[A-Za-z0-9_.-]{1,64}$/.test(pin))
            throw new Error('Unsupported version pin.');
          const pinned = (
            await request(
              `mods/${modId}/versions/${encodeURIComponent(pin)}`,
              versionDetail,
            )
          ).data;
          if (
            pinned.modId !== modId ||
            pinned.version !== pin ||
            !pinned.published ||
            !pinned.approved
          )
            throw new Error(
              `Version pin for ${modId} is not published and approved.`,
            );
          if (pinned.dependencyCount !== pinned.dependencies.length)
            throw new Error('Incomplete pinned dependency metadata.');
          dependencies = pinned.dependencies;
          gameVersion = pinned.gameVersion;
        } else if (latest.dependencyCount !== dependencies.length)
          throw new Error('Incomplete dependency metadata.');
        selected.set(modId, pin || latest.version);
        if (gameVersion)
          warnings.push(
            `${latest.name}: metadata targets game ${gameVersion}; the installed engine must still validate compatibility.`,
          );
        for (const dependency of dependencies) {
          if (edges.length >= 3000)
            throw new Error(
              'Dependency graph exceeds its edge limit. No pack was changed.',
            );
          edges.push({
            from: modId,
            to: dependency.id,
            ...(dependency.version ? { version: dependency.version } : {}),
          });
          await visit(dependency.id, dependency.version || undefined);
        }
        visiting.delete(modId);
        finished.add(modId);
        mods.push(
          root
            ? {
                ...root,
                // A pasted ID has no name. Metadata fills it, the field the
                // host pack schema already allows.
                ...(root.name || !latest.name
                  ? {}
                  : { name: latest.name.slice(0, 120) }),
                ...(root.origin === 'dependency'
                  ? { version: pin || undefined }
                  : pin
                    ? { version: pin }
                    : {}),
              }
            : {
                modId,
                name: latest.name.slice(0, 120),
                origin: 'dependency',
                ...(pin ? { version: pin } : {}),
              },
        );
        versions.push({
          modId,
          selected: pin || latest.version,
          latest: latest.version,
          ...(gameVersion ? { gameVersion } : {}),
        });
      }
      for (const mod of roots) await visit(mod.modId);
      // Disabled selections remain available for later use; obsolete auto-added dependencies are pruned.
      mods.push(...pack.mods.filter((mod) => mod.enabled === false));
      const next = reforgerModpack.parse({ ...pack, mods }),
        report = reforgerModpackReport.parse({
          id: pack.id,
          at: Date.now(),
          provider: 'reforgermods.net',
          mods: finished.size,
          warnings: [...new Set(warnings)],
          edges,
          versions,
        });
      return { pack: next, report };
    },
  };
}
