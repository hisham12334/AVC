import { useState } from 'react';
import type { Decision, TrackItem, TrackModel } from '../ui/model';
import { TrackView } from '../ui/shared';
import {
  api,
  ApiError,
  fileUrl,
  useApi,
  type ApiBill,
  type ApiQuote,
  type ApiQuoteItem,
  type ApiTrack,
  type Auth,
} from './api';
import { BillView } from '../ui/BillView';

const asItem = (i: ApiQuoteItem): TrackItem => ({
  id: i.id,
  title: i.title,
  detail: i.detail,
  severity: i.severity,
  priceAed: i.priceAed,
  decision: i.decision,
  evidence: i.evidence.map((e) => ({ id: e.id, caption: e.caption || e.kind })),
});

function toModel(t: ApiTrack): TrackModel {
  const vehicle = [t.job.modelYear, t.job.make, t.job.model].filter(Boolean).join(' ');
  return {
    vehicleTitle: vehicle,
    plate: t.job.licensePlate ?? '',
    stage: t.job.stage,
    workPaused: t.workPaused,
    advisorName: t.job.advisorName,
    arrivalMethod: t.job.arrivalMethod,
    pendingFinding: t.pendingFinding,
    transfer: t.transfer,
    openQuote: t.openQuote
      ? {
          id: t.openQuote.id,
          version: t.openQuote.version,
          kind: t.openQuote.kind,
          items: t.openQuote.items.map(asItem),
        }
      : null,
    settled: t.decidedQuotes.flatMap((q: ApiQuote) => q.items.map(asItem)),
    timeline: t.timeline.map((e, i) => ({
      id: `${e.type}-${i}`,
      at: new Date(e.at).getTime(),
      text: e.label,
      tone:
        e.type === 'finding_raised'
          ? 'finding'
          : e.type === 'quote_decided'
            ? 'approval'
            : undefined,
    })),
  };
}

type Source = {
  key: string;
  viewPath: string;
  decisionsPath: string;
  filePath: (evidenceId: string) => string;
  auth: Auth;
  billHref: string;
};

// The customer tracker on the real API. Works for a per-job link and for a signed-in portal profile.
function Tracker({ source }: { source: Source }) {
  const { state, reload } = useApi(
    () => api<ApiTrack>(source.viewPath, { auth: source.auth }),
    source.key,
    15_000,
  );
  const [submit, setSubmit] = useState<{ busy: boolean; error?: string }>({ busy: false });

  if (state.kind === 'loading')
    return (
      <div className="track">
        <p className="empty" role="status" style={{ padding: 24 }}>
          Loading your vehicle…
        </p>
      </div>
    );
  if (state.kind === 'error')
    return (
      <div className="track">
        <section className="t-card" style={{ margin: 16 }} role="alert">
          <h2>
            {state.error.code === 'LINK_INVALID'
              ? 'This link has expired'
              : 'We could not load this page'}
          </h2>
          <p className="muted">
            {state.error.code === 'LINK_INVALID'
              ? 'Please ask your AVC advisor to send you a fresh link.'
              : state.error.message}
          </p>
        </section>
      </div>
    );

  const open = state.data.openQuote;
  return (
    <TrackView
      model={toModel(state.data)}
      state={submit}
      billHref={source.billHref}
      loadEvidence={(id) => fileUrl(source.filePath(id), source.auth)}
      onSubmit={async (choices: Record<string, Decision>) => {
        if (!open || open.items.some((i) => !choices[i.id])) return false;
        setSubmit({ busy: true });
        try {
          await api(source.decisionsPath, {
            method: 'POST',
            auth: source.auth,
            body: {
              quoteId: open.id,
              quoteVersion: open.version,
              decisions: open.items.map((i) => ({ itemId: i.id, decision: choices[i.id] })),
            },
          });
          setSubmit({ busy: false });
          reload();
          return true;
        } catch (e) {
          const message =
            e instanceof ApiError && e.code === 'QUOTE_ALREADY_DECIDED'
              ? 'This quote was already answered. Showing the latest status.'
              : e instanceof ApiError
                ? e.message
                : 'Could not save your answer.';
          setSubmit({ busy: false, error: message });
          reload();
          return false;
        }
      }}
    />
  );
}

// /track/<token>: one job, no login. The link in the URL is the only credential.
export function LiveTrack({ token }: { token: string }) {
  const t = encodeURIComponent(token);
  return (
    <Tracker
      source={{
        key: token,
        viewPath: `/api/track/${t}`,
        decisionsPath: `/api/track/${t}/decisions`,
        filePath: (id) => `/api/track/${t}/evidence/${id}/file`,
        auth: 'none',
        billHref: '#/bill',
      }}
    />
  );
}

export function PortalJobTracker({ jobId }: { jobId: string }) {
  return (
    <Tracker
      source={{
        key: jobId,
        viewPath: `/api/portal/jobs/${jobId}`,
        decisionsPath: `/api/portal/jobs/${jobId}/decisions`,
        filePath: (id) => `/api/portal/evidence/${id}/file`,
        auth: 'customer',
        billHref: `#/bill/${jobId}`,
      }}
    />
  );
}

// The customer's bill, from either kind of access.
export function BillScreen({ path, auth, back }: { path: string; auth: Auth; back: string }) {
  const { state, reload } = useApi(() => api<{ bill: ApiBill }>(path, { auth }), path);
  return (
    <div className="bill-page">
      <a className="link back no-print" href={back}>
        ← Back
      </a>
      {state.kind === 'loading' && <p className="empty">Loading…</p>}
      {state.kind === 'error' && (
        <p className="banner banner-critical" role="alert">
          {state.error.message}{' '}
          <button type="button" className="btn" onClick={reload}>
            Try again
          </button>
        </p>
      )}
      {state.kind === 'ready' && <BillView bill={state.data.bill} customer={auth !== 'staff'} />}
    </div>
  );
}
