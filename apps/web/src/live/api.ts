import { useCallback, useEffect, useRef, useState } from 'react';
import type { Severity, StageKey } from '../ui/model';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Staff sign-in is not configured yet (OIDC provider is an open client decision). Until it is, a
// verified bearer token can be pasted in; it is kept for this browser tab only.
const TOKEN_KEY = 'avc.staffToken';
export const staffToken = {
  get(): string | null {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(value: string | null): void {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable: the token simply is not remembered */
    }
  },
};

export async function api<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; staff?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.staff) {
    const token = staffToken.get();
    if (token) headers.authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      cache: 'no-store',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection.');
  }
  if (response.status === 204) return undefined as T;
  const data = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  if (!response.ok)
    throw new ApiError(
      response.status,
      data?.error?.code ?? 'ERROR',
      data?.error?.message ?? 'Something went wrong. Please try again.',
    );
  return data as T;
}

export type Load<T> =
  { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error'; error: ApiError };

// Fetch on mount and whenever `key` changes; optionally refresh quietly so status stays live.
export function useApi<T>(
  load: () => Promise<T>,
  key: string,
  refreshMs = 0,
): { state: Load<T>; reload: () => void } {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' });
  const loader = useRef(load);
  loader.current = load;
  const run = useCallback((quiet: boolean) => {
    let live = true;
    if (!quiet) setState({ kind: 'loading' });
    loader
      .current()
      .then((data) => live && setState({ kind: 'ready', data }))
      .catch((e: unknown) => {
        if (!live) return;
        // A failed quiet refresh keeps showing the last good data.
        if (quiet) return;
        setState({
          kind: 'error',
          error: e instanceof ApiError ? e : new ApiError(0, 'ERROR', 'Something went wrong.'),
        });
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => run(false), [run, key]);
  useEffect(() => {
    if (!refreshMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') run(true);
    }, refreshMs);
    return () => clearInterval(timer);
  }, [run, refreshMs, key]);
  return { state, reload: () => run(true) };
}

// ---- response shapes (see docs/API_CONTRACTS.md) ----
export type ApiEvidence = { id: string; kind: string; caption: string; capturedAt: string };
export type ApiQuoteItem = {
  id: string;
  position: number;
  title: string;
  detail: string;
  severity: Severity;
  priceAed: number;
  decision: 'pending' | 'approved' | 'rejected';
  decidedAt: string | null;
  evidence: (ApiEvidence & { storageKey?: string })[];
};
export type ApiQuote = {
  id: string;
  version: number;
  kind: 'initial' | 'addendum';
  status: 'sent' | 'decided';
  sentAt: string;
  decidedAt: string | null;
  totalAed: number;
  approvedTotalAed: number;
  items: ApiQuoteItem[];
};
export type ApiTrack = {
  job: {
    jobNumber: string;
    stage: StageKey;
    updatedAt: string;
    make: string;
    model: string;
    modelYear: number | null;
    color: string | null;
    licensePlate: string | null;
    branchName: string;
  };
  workPaused: boolean;
  openQuote: ApiQuote | null;
  decidedQuotes: ApiQuote[];
  timeline: { at: string; type: string; label: string }[];
};
export type ApiSummary = {
  asOf: string;
  capacity: number;
  activeCars: number;
  capacityUsedPercent: number;
  byStage: Record<string, number>;
  aging: { fresh: number; standard: number; delayed: number; critical: number };
  awaitingApproval: number;
  pausedForFinding: number;
  deliveredMtd: number;
  approvedValueMtdAed: number;
  approvedValueTodayAed: number;
};
export type ApiJobSummary = {
  id: string;
  jobNumber: string;
  status: string;
  workStage: StageKey;
  version: number;
  createdAt: string;
  customerName: string;
  make: string;
  model: string;
  licensePlate: string | null;
  responsibleStaffName: string;
  vehicleLocation: string;
  awaitingCustomer: boolean;
};
export type ApiJobDetail = ApiJobSummary & {
  mileageKm: number;
  intakeCondition: string;
  customerMobile: string;
  vin: string | null;
  updatedAt: string;
};
export type ApiJobEvent = {
  id: string;
  jobVersion: number;
  eventType: string;
  fromStatus: string | null;
  toStatus: string;
  actorType: 'staff' | 'customer' | 'system';
  actorStaffName: string;
  occurredAt: string;
  details: Record<string, unknown>;
};
