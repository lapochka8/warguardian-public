import { promises as fs, constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  reforgerModCache,
  reforgerQuarantinedMod,
  type reforgerMod,
  type reforgerModpack,
} from '../games/reforger-host';

type Inventory = z.infer<typeof reforgerModCache>;
type Entry = z.infer<typeof reforgerQuarantinedMod>;
const guid = /^[A-F0-9]{16}$/i;
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const folderSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !/[\\/:]/.test(value) &&
      value !== '.' &&
      value !== '..' &&
      !value
        .split('')
        .some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
  );
const indexSchema = z
  .object({
    version: z.literal(1),
    entries: z
      .array(reforgerQuarantinedMod.extend({ folder: folderSchema }))
      .max(20),
  })
  .strict();
const nativeRevision = z.object({
  version: z.string().min(1).max(64),
  corrupted: z.boolean().optional(),
  package: z
    .object({
      files: z
        .array(
          z.object({
            name: z.string().min(1).max(512),
            size: z.number().int().nonnegative(),
            isDownloaded: z.boolean(),
            isCorrupted: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(5000),
    })
    .optional(),
});
const nativeMeta = z.object({
  meta: z.object({
    id: z.string().regex(guid),
    name: z.string().max(160),
    selectedRev: z.number().int().nonnegative().optional(),
    versions: z.array(nativeRevision).min(1).max(100),
  }),
});
const nativeServerData = z.object({
  id: z.string().regex(guid),
  revision: z.object({
    version: z.string().min(1).max(64),
    corrupted: z.boolean().optional(),
  }),
});
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT';
async function present(path: string) {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
async function directory(path: string) {
  if (
    !(await fs.lstat(path)).isDirectory() ||
    (await fs.realpath(path)) !== path
  )
    throw new Error('Cache path is not a canonical directory.');
}
async function cacheProjectNames(path: string) {
  const entries = await fs.readdir(path, { withFileTypes: true });
  if (entries.length > 6000)
    throw new Error('Addon directory exceeds its entry limit.');
  return entries
    .filter((entry) => entry.name.toLowerCase().endsWith('.gproj'))
    .map((entry) => folderSchema.parse(entry.name))
    .sort();
}
async function smallFile(path: string, maximum = 524288) {
  const before = await fs.lstat(path);
  if (
    !before.isFile() ||
    before.size > maximum ||
    (await fs.realpath(path)) !== path
  )
    throw new Error('Invalid cache metadata file.');
  const file = await fs.open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > maximum ||
      before.ino !== stat.ino ||
      before.dev !== stat.dev ||
      (await fs.realpath(path)) !== path
    )
      throw new Error('Invalid cache metadata file.');
    const bytes = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maximum || bytesRead !== stat.size)
      throw new Error('Cache metadata changed while reading.');
    return bytes
      .subarray(0, bytesRead)
      .toString('utf8')
      .replace(/^\uFEFF/, '');
  } finally {
    await file.close();
  }
}
async function syncDirectory(path: string) {
  if (process.platform !== 'linux') return;
  const handle = await fs.open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function atomic(path: string, value: unknown) {
  const temporary = path + '.' + randomUUID();
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, path);
  await syncDirectory(dirname(path));
}

/** Read only root GameProject identity/dependencies. Nested resource GUIDs are not addon IDs. */
export function readReforgerCacheProject(text: string) {
  const tokens: string[] = [];
  for (let cursor = 0; cursor < text.length;) {
    const rest = text.slice(cursor);
    const ignored = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/.exec(rest);
    if (ignored) {
      cursor += ignored[0].length;
      continue;
    }
    const token = /^(?:"(?:[^"\\]|\\.)*"|[{}]|[^\s{}"]+)/.exec(rest);
    if (!token || tokens.length >= 20000)
      throw new Error('Unsupported addon project metadata.');
    tokens.push(token[0]);
    cursor += token[0].length;
  }
  if (tokens[0] !== 'GameProject' || tokens[1] !== '{')
    throw new Error('Invalid addon project metadata.');
  let depth = 1,
    id: string | null = null,
    name: string | null = null;
  const dependencies: string[] = [];
  const string = (token: string) => z.string().parse(JSON.parse(token));
  for (let cursor = 2; cursor < tokens.length; cursor++) {
    const token = tokens[cursor];
    if (token === '{') {
      if (++depth > 64)
        throw new Error('Addon project nesting exceeds the limit.');
    } else if (token === '}') {
      if (--depth < 0 || (!depth && cursor !== tokens.length - 1))
        throw new Error('Invalid addon project metadata.');
    } else if (depth === 1 && (token === 'GUID' || token === 'TITLE')) {
      const value = string(tokens[++cursor]);
      if (token === 'GUID') {
        if (id !== null || !guid.test(value))
          throw new Error('Ambiguous addon project identity.');
        id = value.toUpperCase();
      } else {
        if (name !== null || value.length > 160)
          throw new Error('Invalid addon project title.');
        name = value;
      }
    } else if (depth === 1 && token === 'Dependencies') {
      if (tokens[++cursor] !== '{')
        throw new Error('Invalid addon dependency metadata.');
      while (tokens[++cursor] !== '}') {
        if (cursor >= tokens.length || dependencies.length >= 300)
          throw new Error('Invalid addon dependency metadata.');
        const value = string(tokens[cursor]);
        if (!guid.test(value))
          throw new Error('Invalid addon dependency identity.');
        dependencies.push(value.toUpperCase());
      }
    }
  }
  if (depth !== 0 || !id) throw new Error('Incomplete addon project identity.');
  return { id, name, dependencies: [...new Set(dependencies)] };
}

export async function createReforgerModCache(
  profile: string,
  stateRoot: string,
  protectPath: (path: string) => void = () => {},
) {
  const root = join(profile, 'addons'),
    indexPath = join(stateRoot, 'mod-cache.json'),
    journalPath = join(stateRoot, 'mod-cache-journal.json');
  let index: z.infer<typeof indexSchema> = { version: 1, entries: [] };
  let recoveryRequired = false;
  if (await present(indexPath))
    index = indexSchema.parse(JSON.parse(await smallFile(indexPath, 131072)));
  const held = (entry: Entry) => join(stateRoot, 'mod-cache-' + entry.id);
  if (await present(journalPath)) {
    const journal = z
      .object({
        action: z.enum(['quarantine', 'restore', 'purge']),
        entry: reforgerQuarantinedMod.extend({ folder: folderSchema }),
        next: indexSchema,
      })
      .strict()
      .parse(JSON.parse(await smallFile(journalPath, 131072)));
    if (journal.action === 'purge') {
      protectPath(held(journal.entry));
      await directory(stateRoot);
      if (await present(held(journal.entry))) {
        if (!index.entries.some((row) => row.id === journal.entry.id))
          throw new Error(
            'Quarantine removal state changed. Host review required.',
          );
        await directory(held(journal.entry));
        index.entries = index.entries.filter(
          (row) => row.id !== journal.entry.id,
        );
        index.entries.unshift({ ...journal.entry, removalPending: true });
      } else index = journal.next;
      await atomic(indexPath, index);
    } else {
      const original = join(root, journal.entry.folder);
      const source =
        journal.action === 'quarantine' ? original : held(journal.entry);
      const target =
        journal.action === 'quarantine' ? held(journal.entry) : original;
      protectPath(source);
      protectPath(target);
      await directory(profile);
      await directory(stateRoot);
      await directory(root);
      const before = await present(source),
        after = await present(target);
      if (before === after)
        throw new Error(
          'Mod cache recovery is ambiguous. Both versions are retained for host review.',
        );
      await directory(before ? source : target);
      if (after) {
        index = journal.next;
        await atomic(indexPath, index);
      }
    }
    await fs.unlink(journalPath);
    await syncDirectory(stateRoot);
  }
  async function inspect(folder: string, budget: { files: number }) {
    folderSchema.parse(folder);
    const path = join(root, folder);
    await directory(path);
    const projects = await cacheProjectNames(path);
    if (projects.length !== 1)
      throw new Error('Cache project metadata is missing or ambiguous.');
    const texts = await Promise.all([
      smallFile(join(path, 'meta')),
      smallFile(join(path, 'ServerData.json')),
      smallFile(join(path, projects[0]), 262144),
    ]);
    const meta = nativeMeta.parse(JSON.parse(texts[0])).meta;
    const server = nativeServerData.parse(JSON.parse(texts[1]));
    const project = readReforgerCacheProject(texts[2]);
    const selected = meta.selectedRev ?? (meta.versions.length === 1 ? 0 : -1);
    const revision = meta.versions[selected];
    if (!revision) throw new Error('Selected cache version is ambiguous.');
    const problems: string[] = [];
    if (
      new Set([meta.id.toUpperCase(), server.id.toUpperCase(), project.id])
        .size !== 1
    )
      problems.push('Cache identities disagree.');
    const directoryId = /(?:^|_)([a-f0-9]{16})$/i
      .exec(folder)?.[1]
      .toUpperCase();
    if (directoryId && directoryId !== meta.id.toUpperCase())
      problems.push('Cache directory identities disagree.');
    if (server.revision.version !== revision.version)
      problems.push('Cache versions disagree.');
    const names = new Set<string>(),
      identities: unknown[] = [];
    let bytes = 0,
      incomplete =
        revision.corrupted === true || server.revision.corrupted === true;
    if (!revision.package) incomplete = true;
    budget.files -= revision.package?.files.length ?? 0;
    if (budget.files < 0)
      throw new Error('Cache inspection file limit reached.');
    for (const file of revision.package?.files ?? []) {
      if (
        !file.name ||
        file.name.length > 240 ||
        file.name
          .split('/')
          .some((part) => !folderSchema.safeParse(part).success) ||
        names.has(file.name.toLowerCase())
      )
        throw new Error('Ambiguous cache package paths.');
      names.add(file.name.toLowerCase());
      const target = join(path, file.name);
      try {
        for (
          let parent = dirname(target);
          parent !== path;
          parent = dirname(parent)
        )
          await directory(parent);
        const stat = await fs.lstat(target);
        const regular = stat.isFile() && (await fs.realpath(target)) === target;
        incomplete ||=
          !regular ||
          stat.size !== file.size ||
          !file.isDownloaded ||
          file.isCorrupted === true;
        if (regular) bytes += stat.size;
        identities.push([
          file.name,
          stat.dev,
          stat.ino,
          stat.size,
          stat.mtimeMs,
          regular,
        ]);
      } catch (error) {
        if (!missing(error)) throw error;
        incomplete = true;
        identities.push([file.name, null]);
      }
    }
    if (incomplete)
      problems.push('Package files are incomplete or marked corrupt.');
    return {
      modId: meta.id.toUpperCase(),
      folder,
      name: meta.name || project.name || meta.id,
      version: revision.version,
      bytes,
      status: problems.some((problem) => problem.includes('disagree'))
        ? ('conflict' as const)
        : incomplete
          ? ('incomplete' as const)
          : ('cached' as const),
      revision: digest([projects[0], texts, identities]),
      dependencies: project.dependencies,
      problems,
    };
  }
  async function scan(
    configured: z.infer<typeof reforgerMod>[],
    packs: z.infer<typeof reforgerModpack>[],
    configRevision: string,
    launchConfiguration: Inventory['launchConfiguration'],
  ) {
    if (recoveryRequired)
      throw new Error(
        'Restart the WarGuardian Agent to finish the interrupted cache move.',
      );
    await directory(profile);
    const mods: Inventory['mods'] = [],
      problems: string[] = [],
      budget = { files: 20000 };
    const folders = (await present(root))
      ? (await directory(root), await fs.readdir(root, { withFileTypes: true }))
      : [];
    if (folders.length > 1000)
      throw new Error('Addon cache exceeds 1,000 entries.');
    for (const folder of folders.sort((a, b) => a.name.localeCompare(b.name))) {
      if (folder.name === 'saves') continue;
      if (!folderSchema.safeParse(folder.name).success) {
        if (problems.length < 30)
          problems.push(
            'An addon directory name is unsafe or exceeds 240 characters.',
          );
        continue;
      }
      const fallback = /(?:^|_)([a-f0-9]{16})$/i
        .exec(folder.name)?.[1]
        .toUpperCase();
      if (
        !fallback &&
        (!folder.isDirectory() ||
          !(await present(join(root, folder.name, 'meta'))))
      ) {
        if (
          folder.isDirectory() &&
          (await cacheProjectNames(join(root, folder.name))).length > 0 &&
          problems.length < 30
        )
          problems.push(`${folder.name}: no Workshop cache metadata.`);
        continue;
      }
      if (mods.length >= 300) throw new Error('Addon cache exceeds 300 mods.');
      try {
        mods.push({
          ...(await inspect(folder.name, budget)),
          requestedVersion: null,
          configured: false,
          required: false,
          references: [],
          referenceCount: 0,
        });
      } catch {
        if (fallback) {
          const stat = await fs.lstat(join(root, folder.name));
          const metadataStats =
            stat.isDirectory() &&
            (await fs.realpath(join(root, folder.name))) ===
              join(root, folder.name)
              ? await Promise.all(
                  [
                    'meta',
                    'ServerData.json',
                    ...(await cacheProjectNames(join(root, folder.name))),
                  ].map(async (name) => {
                    try {
                      const info = await fs.lstat(
                        join(root, folder.name, name),
                      );
                      return [
                        name,
                        info.ino,
                        info.dev,
                        info.size,
                        info.mtimeMs,
                        info.isFile(),
                      ];
                    } catch (error) {
                      if (missing(error)) return [name, null];
                      throw error;
                    }
                  }),
                )
              : [];
          mods.push({
            modId: fallback,
            folder: folder.name,
            name: fallback,
            version: null,
            bytes: 0,
            status: 'unavailable',
            revision: digest([
              folder.name,
              stat.ino,
              stat.dev,
              stat.mtimeMs,
              metadataStats,
            ]),
            dependencies: [],
            requestedVersion: null,
            configured: false,
            required: false,
            references: [],
            referenceCount: 0,
            problems: ['Cache metadata is missing, unsafe or invalid.'],
          });
        } else if (problems.length < 30)
          problems.push('An addon directory has invalid metadata.');
      }
    }
    if (budget.files < 0) {
      if (problems.length === 30) problems.pop();
      problems.push('Cache inspection reached its 20,000-file limit.');
    }
    for (const mod of configured)
      if (!mods.some((row) => row.modId === mod.modId))
        mods.push({
          modId: mod.modId,
          folder: '',
          name: mod.name || mod.modId,
          version: null,
          bytes: 0,
          status: 'incomplete',
          revision: digest(mod),
          dependencies: [],
          problems: ['No cache found.'],
          requestedVersion: null,
          configured: false,
          required: false,
          references: [],
          referenceCount: 0,
        });
    const duplicates = new Set(
      mods
        .filter((row, index) =>
          mods.some((other, at) => at !== index && row.modId === other.modId),
        )
        .map((row) => row.modId),
    );
    for (const mod of mods) {
      const configuredMod = configured.find((row) => row.modId === mod.modId);
      mod.configured = !!configuredMod;
      mod.required = !!configuredMod && configuredMod.required !== false;
      mod.requestedVersion = configuredMod?.version || null;
      const references = [
        ...(configuredMod ? ['Server configuration'] : []),
        ...packs
          .filter((pack) => pack.mods.some((row) => row.modId === mod.modId))
          .map((pack) => pack.name),
        ...mods
          .filter(
            (other) =>
              other.modId !== mod.modId &&
              other.dependencies.includes(mod.modId),
          )
          .map((other) => `Dependency of ${other.name} (${other.modId})`),
      ];
      mod.referenceCount = references.length;
      mod.references = references.slice(0, 8);
      if (duplicates.has(mod.modId)) {
        mod.status = 'conflict';
        mod.problems.push('Duplicate cache identity.');
      }
    }
    const inventory = reforgerModCache.parse({
      at: Date.now(),
      scope: 'profile/addons',
      configRevision,
      launchConfiguration,
      mods,
      problems,
      quarantined: index.entries,
    });
    if (Buffer.byteLength(JSON.stringify(inventory)) > 650000)
      throw new Error(
        'Cache inventory exceeds its 650 kB transfer limit. Host review required.',
      );
    return inventory;
  }
  async function move(
    action: 'quarantine' | 'restore',
    entry: Entry,
    next: typeof index,
  ) {
    if (recoveryRequired)
      throw new Error(
        'Restart the WarGuardian Agent to finish the interrupted cache move.',
      );
    await directory(profile);
    await directory(root);
    await directory(stateRoot);
    const original = join(root, entry.folder),
      source = action === 'quarantine' ? original : held(entry),
      target = action === 'quarantine' ? held(entry) : original;
    protectPath(source);
    protectPath(target);
    await directory(source);
    if (await present(target))
      throw new Error(
        'A cache already occupies the destination. Both versions are retained.',
      );
    await atomic(journalPath, { action, entry, next });
    recoveryRequired = true;
    try {
      await fs.rename(source, target);
    } catch (error) {
      if ((await present(source)) && !(await present(target))) {
        await fs.unlink(journalPath);
        recoveryRequired = false;
      }
      if ((error as NodeJS.ErrnoException).code === 'EXDEV')
        throw new Error('Cache and agent state must share a filesystem.');
      throw error;
    }
    await syncDirectory(root);
    await syncDirectory(stateRoot);
    await atomic(indexPath, next);
    index = next;
    await fs.unlink(journalPath);
    await syncDirectory(stateRoot);
    recoveryRequired = false;
  }
  return {
    scan,
    /** The addon cache directory: the scope of `scan`. */
    root,
    /** The parsed `ServerData.json` of one cached mod directory. */
    async serverData(folder: string): Promise<unknown> {
      folderSchema.parse(folder);
      const path = join(root, folder);
      await directory(root);
      await directory(path);
      return JSON.parse(await smallFile(join(path, 'ServerData.json')));
    },
    async quarantine(
      modId: string,
      revision: string,
      allowReferenced: boolean,
      inventory: Inventory,
    ) {
      if (index.entries.length >= 20)
        throw new Error(
          'Quarantine is full. Restore or remove retained content before adding more.',
        );
      const matches = inventory.mods.filter(
        (row) => row.modId === modId && row.folder,
      );
      if (matches.length !== 1 || matches[0].revision !== revision)
        throw new Error(
          'Cache changed or is ambiguous. Refresh before continuing.',
        );
      const row = matches[0];
      folderSchema.parse(row.folder);
      if (row.references.length && !allowReferenced)
        throw new Error(
          'This cache is referenced. Confirm re-download before continuing.',
        );
      // An unreadable directory can be retained safely, but unsafe links never move.
      await directory(join(root, row.folder));
      const entry: Entry = {
        id: randomUUID(),
        modId,
        folder: row.folder,
        name: row.name,
        version: row.version,
        at: Date.now(),
        removalPending: false,
      };
      await move('quarantine', entry, {
        version: 1,
        entries: [entry, ...index.entries],
      });
    },
    async restore(id: string) {
      const entry = index.entries.find((row) => row.id === id);
      if (!entry) throw new Error('Quarantined cache was not found.');
      if (entry.removalPending)
        throw new Error(
          'Removal was interrupted. Inspect or finish removal before restoring content.',
        );
      folderSchema.parse(entry.folder);
      if (!(await present(root))) await fs.mkdir(root);
      const current = await scan([], [], '', 'stopped');
      if (
        current.problems.length ||
        current.mods.some((row) => row.modId === entry.modId)
      )
        throw new Error(
          'A cache identity already exists or cannot be checked. Both versions are retained.',
        );
      await move('restore', entry, {
        version: 1,
        entries: index.entries.filter((row) => row.id !== id),
      });
    },
    async remove(id: string) {
      if (recoveryRequired)
        throw new Error(
          'Restart the WarGuardian Agent to finish the interrupted cache move.',
        );
      const entry = index.entries.find((row) => row.id === id);
      if (!entry) throw new Error('Quarantined cache was not found.');
      await directory(stateRoot);
      const target = held(entry);
      protectPath(target);
      await directory(target);
      let inspected = 0;
      async function bound(path: string, depth = 0) {
        if (depth > 32)
          throw new Error(
            'Quarantined content exceeds the directory depth limit.',
          );
        const names = await fs.readdir(path, { withFileTypes: true });
        inspected += names.length;
        if (inspected > 20000)
          throw new Error(
            'Quarantined content exceeds the 20,000-entry removal limit.',
          );
        for (const child of names)
          if (child.isDirectory()) {
            const nested = join(path, child.name);
            await directory(nested);
            await bound(nested, depth + 1);
          }
      }
      await bound(target);
      const next = {
        version: 1 as const,
        entries: index.entries.filter((row) => row.id !== id),
      };
      await atomic(journalPath, { action: 'purge', entry, next });
      recoveryRequired = true;
      try {
        await fs.rm(target, { recursive: true });
      } catch (error) {
        if (await present(target)) {
          index.entries = index.entries.map((row) =>
            row.id === id ? { ...row, removalPending: true } : row,
          );
          await atomic(indexPath, index);
          await fs.unlink(journalPath);
          recoveryRequired = false;
        }
        throw error;
      }
      await syncDirectory(stateRoot);
      await atomic(indexPath, next);
      index = next;
      await fs.unlink(journalPath);
      await syncDirectory(stateRoot);
      recoveryRequired = false;
    },
  };
}
