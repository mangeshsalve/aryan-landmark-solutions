import { Request } from 'express';

export function extractBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return undefined;

  return token;
}
