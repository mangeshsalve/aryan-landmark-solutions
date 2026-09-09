import type { Pagination } from '../types/property';

/**
 * The one and only place VITE_API_BASE_URL is read. Every API call in
 * this app goes through apiGet()/apiGetPaginated() below — no component
 * or other module should call fetch() directly or read import.meta.env
 * itself.
 */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

/**
 * Typed error for every failure mode this client can produce: a
 * non-2xx HTTP response, the backend's own {success:false,error}
 * envelope, a network failure, or an unparseable response body. `code`
 * mirrors the backend's error.code (see docs/api/api-conventions.md)
 * when available, falling back to a client-side code otherwise —
 * callers can branch on it, or just display `message`.
 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string };
}

interface DataEnvelope<T> {
  success: true;
  data: T;
}

interface PaginatedEnvelope<T> {
  success: true;
  data: T;
  pagination: Pagination;
}

function buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
  if (!API_BASE_URL) {
    // Fails loudly rather than silently calling a relative (and wrong) URL
    // — a missing .env is a setup mistake, not a runtime condition to
    // degrade gracefully from.
    throw new ApiError(
      'CONFIG_ERROR',
      'The website is not configured with an API address (VITE_API_BASE_URL). See .env.example.',
      0,
    );
  }
  const base = API_BASE_URL.endsWith('/') ? API_BASE_URL : `${API_BASE_URL}/`;
  const url = new URL(path.replace(/^\//, ''), base);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function parseEnvelope<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(
      'INVALID_RESPONSE',
      'The server returned a response that could not be read.',
      response.status,
    );
  }

  const envelope = body as Partial<ErrorEnvelope> & { success?: boolean };
  if (!response.ok || envelope.success === false) {
    throw new ApiError(
      envelope.error?.code ?? 'UNKNOWN_ERROR',
      envelope.error?.message ?? 'Something went wrong. Please try again.',
      response.status,
    );
  }

  return body as T;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init ?? { method: 'GET' });
  } catch {
    throw new ApiError(
      'NETWORK_ERROR',
      'Could not reach the server. Check your connection and try again.',
      0,
    );
  }
}

/** GET a single-resource endpoint whose envelope is {success, data}. */
export async function apiGet<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const response = await fetchJson(buildUrl(path, query));
  const envelope = await parseEnvelope<DataEnvelope<T>>(response);
  return envelope.data;
}

/** GET a paginated-list endpoint whose envelope is {success, data, pagination}. */
export async function apiGetPaginated<T>(
  path: string,
  query?: Record<string, string | number | undefined>,
): Promise<{ data: T; pagination: Pagination }> {
  const response = await fetchJson(buildUrl(path, query));
  const envelope = await parseEnvelope<PaginatedEnvelope<T>>(response);
  return { data: envelope.data, pagination: envelope.pagination };
}

/**
 * POST a write endpoint whose envelope is {success, data} on both a
 * fresh 2xx (201) and an idempotent-duplicate 2xx (200) — the public
 * inquiry endpoints treat both as success with the same shape, so this
 * makes no distinction between them; callers only need the resulting
 * `data`. Non-2xx (400 validation, 404 not-found/not-public, 429 rate
 * limited, 5xx) all raise the same typed ApiError as apiGet/apiGetPaginated.
 */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetchJson(buildUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const envelope = await parseEnvelope<DataEnvelope<T>>(response);
  return envelope.data;
}
