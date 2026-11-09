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

// Staff sign in with email and password; the server returns a session token kept for this tab only.
// An OIDC provider can replace this later without touching the screens.
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

// The customer portal keeps its own token (a profile QR/link token or a password-login session).
const CUSTOMER_KEY = 'avc.customerToken';
export const customerToken = {
  get(): string | null {
    try {
      return sessionStorage.getItem(CUSTOMER_KEY);
    } catch {
      return null;
    }
  },
  set(value: string | null): void {
    try {
      if (value) sessionStorage.setItem(CUSTOMER_KEY, value);
      else sessionStorage.removeItem(CUSTOMER_KEY);
    } catch {
      /* storage unavailable: the token simply is not remembered */
    }
  },
};

export type Auth = 'staff' | 'customer' | 'none';

function authHeader(auth: Auth): Record<string, string> {
  const token =
    auth === 'staff' ? staffToken.get() : auth === 'customer' ? customerToken.get() : null;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, { cache: 'no-store', ...init });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection.');
  }
}

async function failure(response: Response): Promise<ApiError> {
  const data = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  return new ApiError(
    response.status,
    data?.error?.code ?? 'ERROR',
    data?.error?.message ?? 'Something went wrong. Please try again.',
  );
}

export async function api<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    staff?: boolean;
    auth?: Auth;
  } = {},
): Promise<T> {
  const auth: Auth = options.auth ?? (options.staff ? 'staff' : 'none');
  const headers: Record<string, string> = { ...authHeader(auth) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await send(path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 204) return undefined as T;
  if (!response.ok) throw await failure(response);
  return (await response.json()) as T;
}

// Files are protected, so an <img src> cannot carry the sign-in. Fetch with it and show a blob URL.
const blobCache = new Map<string, Promise<string>>();
export function fileUrl(path: string, auth: Auth): Promise<string> {
  const key = `${auth}:${path}`;
  let hit = blobCache.get(key);
  if (!hit) {
    hit = (async () => {
      const response = await send(path, { headers: authHeader(auth) });
      if (!response.ok) throw await failure(response);
      return URL.createObjectURL(await response.blob());
    })();
    hit.catch(() => blobCache.delete(key));
    blobCache.set(key, hit);
  }
  return hit;
}

// Phone photos are large. Shrink to a sensible size before sending so uploads stay quick on mobile data.
export async function shrinkImage(file: Blob, maxSide = 1600): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.82),
    );
    return out && out.size < file.size ? out : file;
  } catch {
    return file;
  }
}

export type Uploaded = { id: string; preview: string; caption: string };

export async function uploadEvidence(
  jobId: string,
  file: Blob,
  kind: 'photo' | 'signature',
  caption: string,
): Promise<Uploaded> {
  const body = kind === 'photo' ? await shrinkImage(file) : file;
  const type = body.type === 'image/png' || body.type === 'image/webp' ? body.type : 'image/jpeg';
  const response = await send(
    `/api/jobs/${jobId}/evidence/upload?kind=${kind}&caption=${encodeURIComponent(caption)}`,
    { method: 'POST', headers: { ...authHeader('staff'), 'content-type': type }, body },
  );
  if (!response.ok) throw await failure(response);
  const data = (await response.json()) as { evidence: { id: string } };
  return { id: data.evidence.id, preview: URL.createObjectURL(body), caption };
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
    advisorName: string;
    arrivalMethod: 'pickup' | 'walk_in';
    returnMethod: 'delivery' | 'collect';
  };
  pricingPending: boolean;
  pendingFinding: boolean;
  transfer: {
    direction: 'pickup' | 'return';
    status: 'scheduled' | 'en_route';
    driverName: string | null;
  } | null;
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
  awaitingPricing: boolean;
  arrivalMethod: 'pickup' | 'walk_in';
  returnMethod: 'delivery' | 'collect';
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

export type ApiBill = {
  document: 'estimate' | 'invoice';
  number: string;
  issuedAt: string;
  business: { name: string; branch: string };
  customer: { name: string; email: string | null; mobile: string };
  vehicle: { title: string; plate: string | null; vin: string | null; mileageKm: number };
  advisor: string;
  stage: string;
  lines: {
    position: number;
    title: string;
    detail: string;
    severity: Severity;
    priceAed: number;
    decision: 'pending' | 'approved' | 'rejected';
    quoteVersion: number;
    kind: 'initial' | 'addendum';
    evidenceCount: number;
  }[];
  totals: { quotedAed: number; approvedAed: number; declinedAed: number };
  paymentStatus: 'due_on_delivery' | 'received' | 'reversed';
  instructions: string[];
  terms: string[];
};
export type ApiStaff = {
  id: string;
  displayName: string;
  role: string;
  branchId: string | null;
  email: string | null;
  mustChangePassword: boolean;
};
export type ApiStaffMember = {
  id: string;
  displayName: string;
  email: string | null;
  role: string;
  branchId: string | null;
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
};
export type ApiCustomer = {
  id: string;
  fullName: string;
  mobileNumber: string;
  email: string | null;
};
export type ApiVehicle = {
  id: string;
  vin: string | null;
  licensePlate: string | null;
  make: string;
  model: string;
  modelYear: number | null;
  color: string | null;
};
export type ApiQueueJob = {
  id: string;
  jobNumber: string;
  stage: StageKey;
  version: number;
  updatedAt: string;
  intakeCondition: string;
  mileageKm: number;
  make: string;
  model: string;
  modelYear: number | null;
  color: string | null;
  licensePlate: string | null;
  awaitingPricing: boolean;
  findingCount: number;
};
export type ApiFinding = {
  id: string;
  position: number;
  title: string;
  detail: string;
  severity: Severity;
  evidence: { id: string; kind: string; caption: string }[];
};
export type ApiFindingBatch = {
  id: string;
  kind: 'initial' | 'addendum';
  status: 'awaiting_pricing' | 'priced';
  findings: ApiFinding[];
};
export type ApiTransfer = {
  id: string;
  direction: 'pickup' | 'return';
  status: 'scheduled' | 'en_route';
  address: string;
  contactPhone: string | null;
  notes: string;
  windowStart: string | null;
  windowEnd: string | null;
  jobId: string;
  jobNumber: string;
  stage: StageKey;
  make: string;
  model: string;
  color: string | null;
  licensePlate: string | null;
  customerName: string;
  customerMobile: string;
};
export type ApiPortalMe = {
  customer: {
    id: string;
    fullName: string;
    email: string;
    mobileNumber: string;
    passwordIsDefault: boolean;
    serviceRemindersOptIn: boolean;
  };
  vehicles: ApiVehicle[];
  jobs: {
    id: string;
    jobNumber: string;
    stage: StageKey;
    createdAt: string;
    updatedAt: string;
    make: string;
    model: string;
    licensePlate: string | null;
    awaitingYou: boolean;
    mileageKm: number;
    intakeCondition: string;
  }[];
};

export type ApiCustomerProfile = {
  customer: ApiCustomer & { createdAt: string };
  vehicles: (ApiVehicle & { id: string; createdAt: string })[];
  jobs: {
    id: string;
    jobNumber: string;
    stage: StageKey;
    createdAt: string;
    updatedAt: string;
    mileageKm: number;
    intakeCondition: string;
    vehicleId: string;
    make: string;
    model: string;
    licensePlate: string | null;
  }[];
};
