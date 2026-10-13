import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = join(root, 'dist/native/snapshot');
const allTargets = [
  ['linux', 'amd64'], ['linux', 'arm64'],
  ['darwin', 'amd64'], ['darwin', 'arm64'],
  ['windows', 'amd64'],
];
const hostArch = process.arch === 'x64' ? 'amd64' : process.arch;
const targets = process.argv.includes('--host-only')
  ? allTargets.filter(([goos, goarch]) => goos === process.platform && goarch === hostArch)
  : allTargets;
if (targets.length === 0) throw new Error(`Unsupported native-helper host: ${process.platform}/${process.arch}`);
await mkdir(output, { recursive: true });
for (const [goos, goarch] of targets) {
  const suffix = goos === 'windows' ? '.exe' : '';
  const out = join(output, `simcp-snapshot-${goos}-${goarch}${suffix}`);
  const result = spawnSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', out, '.'], {
    cwd: join(root, 'native/snapshot'),
    env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
