export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: Record<string, unknown>) { super(message); }
}
export class UpstreamError extends AppError {
  constructor(code: string, status = 502, details?: Record<string, unknown>) { super(code, 'The upstream request failed. Check permissions or retry later.', status, details); }
}
