export class SimulationError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export function requireThat(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new SimulationError(code, message);
}
export function errorData(error: unknown) {
  if (error instanceof SimulationError) return { code: error.code, message: error.message, details: error.details };
  if (error instanceof Error && error.name === 'ZodError') return { code: 'invalid_input', message: error.message };
  if (error instanceof Error && 'code' in error) {
    if (error.code === 'ENOENT') return { code: 'file_not_found', message: 'A required local artifact or run record does not exist.' };
    if (['EACCES', 'EPERM', 'ELOOP', 'EISDIR'].includes(String(error.code))) return { code: 'path_policy', message: 'A required artifact is inaccessible or is not an allowed regular file.' };
  }
  // Native errors may contain arbitrary host paths or environment data.
  return { code: 'internal_error', message: 'Operation failed; inspect the retained workspace diagnostics.' };
}
