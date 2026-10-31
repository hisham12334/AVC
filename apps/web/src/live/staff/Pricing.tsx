import { useState } from 'react';
import { BillView } from '../../ui/BillView';
import { EvidenceThumb } from '../../ui/evidence';
import { Card, Icon, SeverityBadge, aed, ago } from '../../ui/ui';
import {
  api,
  useApi,
  type ApiBill,
  type ApiFindingBatch,
  type ApiJobDetail,
  type ApiJobSummary,
} from '../api';
import {
  Field,
  Loading,
  Page,
  Problem,
  messageOf,
  staffFile,
  stageLabel,
  vehicleTitle,
} from './common';

export function PricingQueue() {
  const { state, reload } = useApi(
    () => api<{ jobs: ApiJobSummary[] }>('/api/jobs', { staff: true }),
    'price-queue',
    15_000,
  );
  if (state.kind === 'loading')
    return (
      <Page title="Quotes to price">
        <Loading />
      </Page>
    );
  if (state.kind === 'error')
    return (
      <Page title="Quotes to price">
        <Problem error={state.error} retry={reload} />
      </Page>
    );
  const jobs = state.data.jobs.filter((j) => j.awaitingPricing);
  return (
    <Page title="Quotes to price" eyebrow="Inspection complete, waiting for you">
      {jobs.length === 0 && (
        <p className="empty">Nothing waiting. Findings from the workshop appear here.</p>
      )}
      <ul className="queue">
        {jobs.map((j) => (
          <li key={j.id}>
            <a href={`#/price/${j.id}`} className="qcard hot">
              <div className="qcard-top">
                <strong>
                  {j.make} {j.model} · {j.licensePlate ?? 'No plate'}
                </strong>
                <span className="muted small">AVC-{j.jobNumber}</span>
              </div>
              <p className="qcard-note">{j.customerName}</p>
              <div className="qcard-foot">
                <span className="chip">{stageLabel(j.workStage)}</span>
                {j.workStage !== 'pricing' && (
                  <span className="sev sev-critical">
                    <i />
                    Work paused
                  </span>
                )}
                <span className="muted small">{ago(new Date(j.createdAt).getTime())}</span>
                <span className="qcard-go">
                  Price it <Icon name="arrow" size={14} />
                </span>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </Page>
  );
}

type Line = {
  key: string;
  findingId?: string;
  title: string;
  detail: string;
  price: string;
  severity: ApiBill['lines'][number]['severity'];
};
let extraCounter = 0;
const validPrice = (v: string) => /^\d{1,7}(\.\d{1,2})?$/.test(v.trim());

// The advisor types what each finding costs. Nothing else is entered twice: the bill below is built from it.
export function PricingEditor({ id }: { id: string }) {
  const job = useApi(
    () => api<{ job: ApiJobDetail }>(`/api/jobs/${id}`, { staff: true }),
    `pj-${id}`,
  );
  const found = useApi(
    () => api<{ batches: ApiFindingBatch[] }>(`/api/jobs/${id}/findings`, { staff: true }),
    `pf-${id}`,
  );
  const [lines, setLines] = useState<Line[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<{ link: string | null; kind: string } | null>(null);
  const [copied, setCopied] = useState(false);

  if (job.state.kind === 'loading' || found.state.kind === 'loading')
    return (
      <Page title="Price the quote">
        <Loading />
      </Page>
    );
  if (job.state.kind === 'error')
    return (
      <Page title="Price the quote">
        <Problem error={job.state.error} retry={job.reload} />
      </Page>
    );
  if (found.state.kind === 'error')
    return (
      <Page title="Price the quote">
        <Problem error={found.state.error} retry={found.reload} />
      </Page>
    );

  const j = job.state.data.job;
  const batch = found.state.data.batches.find((b) => b.status === 'awaiting_pricing');

  if (posted)
    return (
      <Page title="Quote posted">
        <Card>
          <p
            className="banner"
            style={{ background: 'var(--blue-tint)', color: 'var(--blue-ink)' }}
          >
            <Icon name="check" size={16} /> The customer can now see the findings and prices.
          </p>
          {posted.link && (
            <>
              <p className="muted">
                Send this message to {j.customerName} ({j.customerMobile}). Automatic WhatsApp
                messages come later; for now copy and send it.
              </p>
              <p className="link-box">
                {`Hello ${j.customerName}, the inspection of your ${j.make} ${j.model} is complete and your quote is ready to review: ${posted.link}`}
              </p>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  void navigator.clipboard?.writeText(
                    `Hello ${j.customerName}, the inspection of your ${j.make} ${j.model} is complete and your quote is ready to review: ${posted.link}`,
                  );
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1800);
                }}
              >
                <Icon name="link" size={15} /> {copied ? 'Copied' : 'Copy message'}
              </button>
            </>
          )}
          <div className="actions end">
            <a className="btn ghost" href={`#/bill/${id}`}>
              View bill
            </a>
            <a className="btn" href="#/price">
              Next quote
            </a>
          </div>
        </Card>
      </Page>
    );

  if (!batch)
    return (
      <Page title="Price the quote">
        <p className="empty">Nothing is waiting to be priced on this car.</p>
        <a className="link" href="#/price">
          Back to the list
        </a>
      </Page>
    );

  // Start from the technician's findings. The advisor may reword them for the customer.
  const current: Line[] =
    lines ??
    batch.findings.map((f) => ({
      key: f.id,
      findingId: f.id,
      title: f.title,
      detail: f.detail,
      price: '',
      severity: f.severity,
    }));
  const patch = (key: string, p: Partial<Line>) =>
    setLines(current.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const complete =
    current.length > 0 && current.every((l) => l.title.trim() && validPrice(l.price));
  const total =
    current.reduce((a, l) => a + (validPrice(l.price) ? Math.round(Number(l.price) * 100) : 0), 0) /
    100;

  const preview: ApiBill = {
    document: 'estimate',
    number: `Q-${j.jobNumber}`,
    issuedAt: new Date().toISOString(),
    business: { name: 'AVC Garage & Bodyshop', branch: 'Al Quoz 1' },
    customer: { name: j.customerName, email: null, mobile: j.customerMobile },
    vehicle: {
      title: `${j.make} ${j.model}`,
      plate: j.licensePlate,
      vin: j.vin,
      mileageKm: j.mileageKm,
    },
    advisor: j.responsibleStaffName,
    stage: j.workStage,
    lines: current.map((l, i) => ({
      position: i + 1,
      title: l.title || 'Untitled',
      detail: l.detail,
      severity: l.severity,
      priceAed: validPrice(l.price) ? Number(l.price) : 0,
      decision: 'pending',
      quoteVersion: 1,
      kind: batch.kind,
      evidenceCount: batch.findings.find((f) => f.id === l.findingId)?.evidence.length ?? 0,
    })),
    totals: { quotedAed: total, approvedAed: 0, declinedAed: 0 },
    paymentStatus: 'due_on_delivery',
    instructions: [
      'Open your AVC profile and review each line with its photos.',
      'Approve or reject every line. Work starts only on the lines you approve.',
      'Payment is settled on delivery of your car.',
    ],
    terms: ['12-month / 20,000 km warranty on repairs and parts.'],
  };

  async function post() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ customerLink: { path: string } | null; quote: { kind: string } }>(
        `/api/jobs/${id}/quotes`,
        {
          method: 'POST',
          staff: true,
          body: {
            expectedVersion: j.version,
            items: current.map((l) => ({
              ...(l.findingId && { findingId: l.findingId }),
              title: l.title.trim(),
              detail: l.detail.trim(),
              priceAed: Number(l.price),
            })),
          },
        },
      );
      setPosted({
        link: r.customerLink ? `${location.origin}${r.customerLink.path}` : null,
        kind: r.quote.kind,
      });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title={`Price ${vehicleTitle(j)}`}
      eyebrow={`AVC-${j.jobNumber} · ${j.customerName} · ${batch.kind === 'addendum' ? 'Found during work' : 'Inspection'}`}
    >
      <a className="link back" href="#/price">
        ← Quotes to price
      </a>
      <div className="grid-2 detail-grid">
        <div className="stack">
          <ul className="drafts">
            {current.map((l) => {
              const f = batch.findings.find((x) => x.id === l.findingId);
              return (
                <li key={l.key} className={`draft edge-${l.severity}`}>
                  <div className="draft-top">
                    <SeverityBadge level={l.severity} />
                    <input
                      className="draft-title"
                      value={l.title}
                      onChange={(e) => patch(l.key, { title: e.target.value })}
                      aria-label="Line title"
                    />
                    {!l.findingId && (
                      <button
                        type="button"
                        className="btn ghost"
                        aria-label="Remove line"
                        onClick={() => setLines(current.filter((x) => x.key !== l.key))}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    )}
                  </div>
                  {f && f.evidence.length > 0 && (
                    <div className="thumbs">
                      {f.evidence.map((e) => (
                        <EvidenceThumb key={e.id} id={e.id} caption={e.caption} load={staffFile} />
                      ))}
                    </div>
                  )}
                  <Field label="What the customer reads">
                    <textarea
                      rows={2}
                      value={l.detail}
                      onChange={(e) => patch(l.key, { detail: e.target.value })}
                    />
                  </Field>
                  <Field label="Price (AED)">
                    <input
                      className="price-input"
                      inputMode="decimal"
                      value={l.price}
                      onChange={(e) => patch(l.key, { price: e.target.value })}
                      placeholder="0.00"
                      aria-invalid={l.price !== '' && !validPrice(l.price)}
                    />
                  </Field>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="btn ghost"
            onClick={() =>
              setLines([
                ...current,
                {
                  key: `x${(extraCounter += 1)}`,
                  title: '',
                  detail: '',
                  price: '',
                  severity: 'minor',
                },
              ])
            }
          >
            <Icon name="plus" size={15} /> Add a service line
          </button>
          <div className="sticky-bar">
            <div className="tally">
              <strong>{aed(total, 2)}</strong>
              <span className="muted small">{current.length} lines</span>
            </div>
            {error && (
              <span className="banner banner-critical" role="alert">
                {error}
              </span>
            )}
            <button
              type="button"
              className="btn primary lg"
              disabled={!complete || busy}
              onClick={post}
            >
              {busy ? 'Posting…' : 'Post to customer'}
            </button>
          </div>
        </div>
        <div className="stack">
          <p className="note">This is what the customer will see on their bill.</p>
          <BillView bill={preview} preview />
        </div>
      </div>
    </Page>
  );
}
