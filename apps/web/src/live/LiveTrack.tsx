import { useState } from 'react';
import type { Decision, TrackItem, TrackModel } from '../ui/model';
import { TrackView } from '../ui/shared';
import { api, ApiError, useApi, type ApiQuote, type ApiQuoteItem, type ApiTrack } from './api';

const asItem = (i: ApiQuoteItem): TrackItem => ({
  id: i.id,
  title: i.title,
  detail: i.detail,
  severity: i.severity,
  priceAed: i.priceAed,
  decision: i.decision,
  evidence: i.evidence.map((e) => e.caption || e.kind),
});

function toModel(t: ApiTrack): TrackModel {
  const vehicle = [t.job.modelYear, t.job.make, t.job.model].filter(Boolean).join(' ');
  return {
    vehicleTitle: vehicle,
    plate: t.job.licensePlate ?? '',
    stage: t.job.stage,
    workPaused: t.workPaused,
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

// Customer tracker on the real API. The link token in the URL is the only credential.
export function LiveTrack({ token }: { token: string }) {
  const { state, reload } = useApi(
    () => api<ApiTrack>(`/api/track/${encodeURIComponent(token)}`),
    token,
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
      onSubmit={async (choices: Record<string, Decision>) => {
        if (!open || open.items.some((i) => !choices[i.id])) return false;
        setSubmit({ busy: true });
        try {
          await api(`/api/track/${encodeURIComponent(token)}/decisions`, {
            method: 'POST',
            body: {
              quoteId: open.id,
              quoteVersion: open.version,
              decisions: open.items.map((i) => ({
                itemId: i.id,
                decision: choices[i.id],
              })),
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
