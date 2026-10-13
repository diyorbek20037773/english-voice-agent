import type { ApiErrorBody } from '../../../shared/api-types.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const NETWORK_ERROR_MESSAGE = 'Cannot reach the server. Check your internet connection and try again.';

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', NETWORK_ERROR_MESSAGE);
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as (T & Partial<ApiErrorBody>) | null;
  if (!res.ok) {
    const code = data?.error?.code ?? `http_${res.status}`;
    const message =
      data?.error?.message ?? (res.status === 429 ? 'Too many requests. Wait a moment and try again.' : `Request failed (HTTP ${res.status}).`);
    throw new ApiError(res.status, code, message);
  }
  return data as T;
}
