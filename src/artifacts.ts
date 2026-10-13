import { constants } from 'node:fs';
import { mkdir, open, realpath, writeFile, chmod, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artifactSchema, type ArtifactRef } from './schemas.js';
import { SimulationError, requireThat } from './errors.js';

export const digest = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')); };
export class Artifacts {
  private constructor(public workspace: string, public roots: string[]) {}
  static async create(workspace: string, roots: string[]) {
    requireThat(process.platform === 'linux', 'unsupported_platform', 'V1 secure descriptor containment requires Linux /proc.');
    requireThat(roots.every(isAbsolute), 'path_policy', 'Input roots must be absolute paths.');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const canonical = await realpath(workspace);
    const info = await stat(canonical);
    requireThat(info.uid === process.getuid?.() && (info.mode & 0o077) === 0, 'path_policy', 'Workspace must be owned by this user with mode 0700.');
    return new Artifacts(canonical, [...await Promise.all(roots.map(r => realpath(r))), canonical]);
  }
  async directory() {
    const path = join(this.workspace, randomUUID());
    await mkdir(path, { mode: 0o700 });
    return path;
  }
  async bytes(uri: string): Promise<Buffer> {
    let url: URL;
    try {
      requireThat(!decodeURIComponent(uri).split('/').includes('..'), 'path_policy', 'Traversal segments are not allowed.');
      url = new URL(uri);
    } catch (error) {
      if (error instanceof SimulationError) throw error;
      throw new SimulationError('invalid_input', 'Malformed artifact URI.');
    }
    requireThat(url.protocol === 'file:' && !url.host && !url.search && !url.hash, 'path_policy', 'Only local file URIs without query or fragment are supported.');
    const path = fileURLToPath(url);
    const canonical = await realpath(path);
    requireThat(this.roots.some(r => inside(r, canonical)), 'path_policy', 'Input lies outside allowed roots.');
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      // Recheck the opened descriptor, not a potentially raced pathname.
      const actual = await realpath(`/proc/self/fd/${handle.fd}`);
      requireThat(this.roots.some(r => inside(r, actual)), 'path_policy', 'Opened file escaped allowed roots.');
      const before = await handle.stat({ bigint: true });
      requireThat(before.isFile(), 'path_policy', 'Artifact must be a regular file.');
      const first = await handle.readFile();
      const second = Buffer.alloc(first.length);
      let offset = 0;
      while (offset < second.length) {
        const { bytesRead } = await handle.read(second, offset, second.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      requireThat(before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs && offset === first.length && digest(first) === digest(second), 'stale_artifact', 'Input changed while being snapshotted.');
      requireThat(await realpath(path) === actual, 'stale_artifact', 'Input locator changed during snapshot.');
      return first;
    } finally { await handle.close(); }
  }
  async verify(ref: ArtifactRef, format?: string) {
    artifactSchema.parse(ref);
    requireThat(ref.uri, 'invalid_input', 'A local artifact locator is required.');
    requireThat(!format || ref.format === format, 'unsupported_format', `Expected ${format}.`);
    const bytes = await this.bytes(ref.uri);
    requireThat(digest(bytes) === ref.revision, 'stale_artifact', 'Artifact revision no longer matches its exact bytes.');
    return bytes;
  }
  async put(dir: string, name: string, bytes: string | Uint8Array, format: string, units?: string): Promise<ArtifactRef> {
    requireThat(inside(this.workspace, resolve(dir, name)), 'path_policy', 'Output escaped workspace.');
    const path = join(dir, name);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o400 });
    return artifactSchema.parse({ revision: digest(bytes), uri: pathToFileURL(path).href, format, ...(units ? { units } : {}) });
  }
  async capture(path: string, format: string, units?: string): Promise<ArtifactRef> {
    requireThat(inside(this.workspace, await realpath(path)), 'path_policy', 'Output escaped workspace.');
    const bytes = await this.bytes(pathToFileURL(path).href);
    await chmod(path, 0o400);
    return artifactSchema.parse({ revision: digest(bytes), uri: pathToFileURL(path).href, format, ...(units ? { units } : {}) });
  }
  async json<T>(ref: ArtifactRef, schema: { parse(x: unknown): T }): Promise<T> {
    return schema.parse(JSON.parse((await this.verify(ref, 'json')).toString('utf8')));
  }
}
