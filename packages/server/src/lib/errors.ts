export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const unauthorized = (msg = 'Sign in required'): HttpError =>
  new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'Not allowed'): HttpError => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'Not found'): HttpError => new HttpError(404, msg, 'notfound');
export const badRequest = (msg: string): HttpError => new HttpError(400, msg, 'bad_request');
export const conflict = (msg: string): HttpError => new HttpError(409, msg, 'conflict');
