import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdir, realpath, writeFile, chmod, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, join, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { artifactSchema, type ArtifactRef } from './schemas.js';
import { SimulationError, requireThat } from './errors.js';

export const digest = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
function snapshotHelper(): string {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const arch = process.arch === 'x64' ? 'amd64' : process.arch;
  const name = `simcp-snapshot-${process.platform}-${arch}${extension}`;
  const override = process.env.SIMULATION_SNAPSHOT_HELPER;
  if (override) return override;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(moduleDir, '../native/snapshot', name), join(moduleDir, '../dist/native/snapshot', name)];
  const helper = candidates.find(existsSync);
  requireThat(helper, 'unsupported_platform', `Secure snapshot helper is not installed for ${process.platform}/${process.arch}.`);
  return helper;
}
type RootIdentity = { path: string; device: string; inode: string };
async function secureSnapshot(path: string, roots: RootIdentity[]): Promise<Buffer> {
  const child = spawn(snapshotHelper(), [], { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { PATH: process.env.PATH ?? '' } });
  const chunks: Buffer[] = [], errors: Buffer[] = [];
  let errorSize = 0, timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 60_000);
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => {
    if (errorSize < 4096) { const kept = chunk.subarray(0, 4096 - errorSize); errors.push(kept); errorSize += kept.length; }
  });
  try {
    const result = await new Promise<{ code: number | null; err?: Error }>(done => {
      child.once('error', err => done({ code: null, err }));
      child.once('close', code => done({ code }));
      child.stdin.end(JSON.stringify({ path, roots }));
    });
    if (result.err) throw new SimulationError('spawn_error', `Could not start secure snapshot helper: ${result.err.message}`);
    if (timedOut) throw new SimulationError('process_failed', 'Secure artifact snapshot exceeded its 60 second limit.');
    if (result.code !== 0) {
      const message = Buffer.concat(errors).toString('utf8').trim();
      if (message.startsWith('stale_artifact:')) throw new SimulationError('stale_artifact', 'Input changed while being snapshotted.');
      if (message.startsWith('invalid_input:')) throw new SimulationError('invalid_input', 'Secure snapshot helper rejected its request.');
      throw new SimulationError('path_policy', message.replace(/^path_policy:\s*/, '') || 'Secure snapshot helper rejected the input.');
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}
export class Artifacts {
  private constructor(public workspace: string, public roots: RootIdentity[]) {}
  static async create(workspace: string, roots: string[]) {
    requireThat(process.platform === 'linux' || process.platform === 'darwin', 'unsupported_platform', 'Private workspace verification is not yet supported on this platform.');
    requireThat(roots.every(isAbsolute), 'path_policy', 'Input roots must be absolute paths.');
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const canonical = await realpath(workspace);
    const info = await stat(canonical);
    requireThat(info.uid === process.getuid?.() && (info.mode & 0o077) === 0, 'path_policy', 'Workspace must be owned by this user with mode 0700.');
    const paths = [...await Promise.all(roots.map(r => realpath(r))), canonical];
    const identities = await Promise.all(paths.map(async path => {
      const root = await stat(path, { bigint: true });
      requireThat(root.dev !== 0n && root.ino !== 0n, 'path_policy', 'Filesystem root identity is unavailable.');
      return { path, device: root.dev.toString(), inode: root.ino.toString() };
    }));
    return new Artifacts(canonical, identities);
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
    requireThat(this.roots.some(r => inside(r.path, canonical)), 'path_policy', 'Input lies outside allowed roots.');
    const bytes = await secureSnapshot(canonical, this.roots);
    requireThat(await realpath(path) === canonical, 'stale_artifact', 'Input locator changed during snapshot.');
    return bytes;
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
