/** JSON API client for the hosted mode. Adds the CSRF header and normalises errors. */
import type { Op } from '@midden/core';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function api<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      'x-midden-client': '1',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    credentials: 'same-origin',
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (res.status === 401) onUnauthorized?.();
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'error',
      err?.message ?? `${res.status} ${res.statusText}`,
    );
  }
  return data as T;
}

/** Multipart POST for file uploads; same error handling as `api`. */
export async function apiUpload<T>(url: string, form: FormData): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-midden-client': '1' },
    body: form,
    credentials: 'same-origin',
  });
  if (res.status === 401) onUnauthorized?.();
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'error',
      err?.message ?? `${res.status} ${res.statusText}`,
    );
  }
  return data as T;
}

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'analyst' | 'viewer';
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  hasPassword: boolean;
}

export interface CaseAccess {
  read: boolean;
  edit: boolean;
  manage: boolean;
  role: string | null;
}

export interface CaseSummary {
  id: string;
  name: string;
  number: string;
  analyst: string;
  classification: string;
  createdAt: string;
  modifiedAt: string;
  archivedAt: string | null;
  restricted: boolean;
  seq: number;
  hosts: number;
  events: number;
  access: CaseAccess;
}

export interface CaseMember {
  userId: string;
  username: string;
  displayName: string;
  role: 'owner' | 'editor' | 'viewer';
}

export interface OpHistoryItem {
  seq: number;
  ts: string;
  actor: { id: string; name: string };
  type: string;
  op: Op;
  inverse: Op | null;
  clientOpId: string | null;
  baseSeq: number | null;
}
