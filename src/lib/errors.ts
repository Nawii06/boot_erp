export class AppError extends Error {
  readonly code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'REAUTH_REQUIRED' | 'INVALID_INPUT' | 'CONFLICT' | 'UNAVAILABLE' | 'PHASE_NOT_ENABLED';
  constructor(code: AppError['code']) { super(code); this.code = code; }
}

export function errorResponse(error: unknown): Response {
  const code = error instanceof AppError ? error.code : 'UNAVAILABLE';
  const statuses = { UNAUTHENTICATED: 401, FORBIDDEN: 403, REAUTH_REQUIRED: 403, INVALID_INPUT: 400, CONFLICT: 409, UNAVAILABLE: 503, PHASE_NOT_ENABLED:409 };
  return Response.json({ error: { code } }, { status: statuses[code], headers: { 'Cache-Control': 'no-store' } });
}
