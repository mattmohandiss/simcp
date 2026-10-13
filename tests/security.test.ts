import { expect, it, vi } from 'vitest';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Artifacts } from '../src/artifacts.js';
import { temporary } from './helpers.js';

const hooks = vi.hoisted(() => ({ beforeOpen: undefined as (() => Promise<void>) | undefined, afterRead: undefined as (() => Promise<void>) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const before = hooks.beforeOpen; hooks.beforeOpen = undefined;
      await before?.();
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, key) {
          if (key === 'readFile') return async (...readArgs: Parameters<typeof handle.readFile>) => {
            const result = await target.readFile(...readArgs);
            const after = hooks.afterRead; hooks.afterRead = undefined;
            await after?.();
            return result;
          };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

it('rechecks descriptor containment when an ancestor changes after realpath but before open', async () => {
  const root = await temporary(), outside = await temporary();
  const dir = join(root, 'model');
  await mkdir(dir);
  await writeFile(join(dir, 'part.step'), 'allowed');
  await writeFile(join(outside, 'part.step'), 'secret');
  const artifacts = await Artifacts.create(await temporary(), [root]);
  hooks.beforeOpen = async () => {
    await rename(dir, join(root, 'old-model'));
    await symlink(outside, dir);
  };
  await expect(artifacts.bytes(pathToFileURL(join(dir, 'part.step')).href)).rejects.toMatchObject({ code: 'path_policy' });
});

it('detects mutation between the first read and descriptor recheck instead of hashing mixed bytes', async () => {
  const root = await temporary(), path = join(root, 'part.step');
  await writeFile(path, 'original');
  const artifacts = await Artifacts.create(await temporary(), [root]);
  hooks.afterRead = async () => { await writeFile(path, 'modified'); };
  await expect(artifacts.bytes(pathToFileURL(path).href)).rejects.toMatchObject({ code: 'stale_artifact' });
});
