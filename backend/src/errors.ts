export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'invalid_input', msg, details);
export const unauthenticated = (msg: string) => new HttpError(401, 'unauthenticated', msg);
export const forbidden = (code: string, msg: string) => new HttpError(403, code, msg);
// Out-of-scope records are reported exactly like missing ones, so ids cannot be probed across branches.
export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, msg: string, details?: unknown) => new HttpError(409, code, msg, details);
