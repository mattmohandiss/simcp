import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

export type ProcessResult = {
  exitCode: number | null; signal: string | null;
  status: 'exited' | 'timeout' | 'cancelled' | 'output_limit' | 'spawn_error';
  startedAt: string; endedAt: string; stdout: string; stderr: string;
};
export function controlledEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: 'C', LC_ALL: 'C', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', PYTHONDONTWRITEBYTECODE: '1' };
  for (const name of ['HOME', 'PATH', 'PYTHONPATH', 'LD_LIBRARY_PATH', 'ELMER_HOME', 'ELMER_LIB']) if (process.env[name]) env[name] = process.env[name];
  return env;
}
export async function runProcess(executable: string, args: string[], cwd: string, prefix: string, timeoutMs: number, signal?: AbortSignal, maxOutputBytes = 8 * 1024 * 1024): Promise<ProcessResult> {
  const stdoutFile = await open(join(cwd, `${prefix}.stdout`), 'wx', 0o600);
  const stderrFile = await open(join(cwd, `${prefix}.stderr`), 'wx', 0o600);
  const startedAt = new Date().toISOString();
  let status: ProcessResult['status'] = 'exited';
  let size = 0, stdout = '', stderr = '';
  let writes = Promise.resolve();
  const child = spawn(executable, args, { cwd, env: controlledEnvironment(), shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let killTimer: NodeJS.Timeout | undefined;
  const kill = (reason: ProcessResult['status']) => {
    if (status !== 'exited') return;
    status = reason;
    const send = (sig: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, sig); } catch { /* process already exited */ }
    };
    send('SIGTERM');
    killTimer = setTimeout(() => send('SIGKILL'), 1000);
  };
  const timer = setTimeout(() => kill('timeout'), timeoutMs);
  const abort = () => kill('cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const receive = (which: 'stdout' | 'stderr', bytes: Buffer) => {
    const remaining = Math.max(0, maxOutputBytes - size);
    size += bytes.length;
    const kept = bytes.subarray(0, remaining);
    if (which === 'stdout') stdout += kept.toString('utf8'); else stderr += kept.toString('utf8');
    writes = writes.then(async () => { await (which === 'stdout' ? stdoutFile : stderrFile).writeFile(kept); }).catch(() => { kill('output_limit'); });
    if (size > maxOutputBytes) kill('output_limit');
  };
  child.stdout.on('data', (b: Buffer) => receive('stdout', b));
  child.stderr.on('data', (b: Buffer) => receive('stderr', b));
  child.on('error', () => { status = 'spawn_error'; });
  try {
    const result = await new Promise<{ exitCode: number | null; signal: string | null }>(done => child.once('close', (exitCode, sig) => done({ exitCode, signal: sig })));
    if (status !== 'exited' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process group already gone */ }
    }
    await writes;
    return { ...result, status, startedAt, endedAt: new Date().toISOString(), stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
    await Promise.all([stdoutFile.close(), stderrFile.close()]);
  }
}
export function termination(result: ProcessResult): string | undefined {
  if (result.status !== 'exited') return result.status;
  if (result.exitCode !== 0) return 'process_failed';
  if (/\bfatal\b|\berror\s*:|did not converge|failed to converge|not converged/i.test(`${result.stdout}\n${result.stderr}`)) return 'solver_failed';
  return undefined;
}
