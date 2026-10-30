import { useState, type ReactNode } from 'react';
import { STAGES, type Severity, type StageKey } from '../ui/model';
import { Stepper, Trail } from '../ui/shared';
import { Card, Donut, Icon, Kpi, SeverityBadge, aed, ago, fmtDate } from '../ui/ui';
import {
  api,
  ApiError,
  staffToken,
  useApi,
  type ApiJobDetail,
  type ApiJobEvent,
  type ApiJobSummary,
  type ApiQuote,
  type ApiSummary,
} from './api';

const ageDays = (iso: string): number => Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
const ageTone = (days: number): Severity =>
  days >= 15 ? 'critical' : days >= 8 ? 'moderate' : 'minor';

function Problem({ error, retry }: { error: ApiError; retry?: () => void }) {
  return (
    <div className="card" role="alert">
      <h2>Could not load this page</h2>
      <p className="muted">{error.message}</p>
      {error.status === 401 || error.status === 403 ? (
        <button
          type="button"
          className="btn"
          onClick={() => {
            staffToken.set(null);
            location.reload();
          }}
        >
          Sign in again
        </button>
      ) : (
        retry && (
          <button type="button" className="btn" onClick={retry}>
            Try again
          </button>
        )
      )}
    </div>
  );
}
const Loading = () => (
  <p className="empty" role="status">
    Loading…
  </p>
);

// ---------------- overview ----------------
export function LiveOverview() {
  const { state, reload } = useApi(
    () => api<ApiSummary>('/api/dashboard/summary', { staff: true }),
    'summary',
    30_000,
  );
  const { state: branches } = useApi(
    () =>
      api<{ branches: { id: string; name: string; bayCapacity: number }[] }>('/api/branches', {
        staff: true,
      }),
    'branches',
  );
  if (state.kind === 'loading')
    return (
      <Page title="Operations overview">
        <Loading />
      </Page>
    );
  if (state.kind === 'error')
    return (
      <Page title="Operations overview">
        <Problem error={state.error} retry={reload} />
      </Page>
    );
  const s = state.data;
  const stages = STAGES.filter((x) => x.key !== 'delivered').map((x) => ({
    ...x,
    count: s.byStage[x.key] ?? 0,
  }));
  const max = Math.max(1, ...stages.map((x) => x.count));
  const branchName =
    branches.kind === 'ready' ? branches.data.branches.map((b) => b.name).join(' · ') : '';
  return (
    <Page
      title="Operations overview"
      eyebrow={branchName}
      aside={
        <span className="pill">
          <Icon name="clock" size={14} /> Updated {ago(new Date(s.asOf).getTime())}
        </span>
      }
    >
      <div className="kpi-grid">
        <Kpi
          label="Cars in workshop"
          icon="car"
          value={
            <>
              {s.activeCars}
              <small> / {s.capacity} bays</small>
            </>
          }
          progress={s.capacityUsedPercent}
          sub={`${s.capacityUsedPercent}% capacity used`}
        />
        <Kpi
          label="Awaiting customer"
          icon="clock"
          tone={s.awaitingApproval ? 'moderate' : undefined}
          value={s.awaitingApproval}
          sub="Quotes waiting for approve / reject"
        />
        <Kpi
          label="Work paused"
          icon="alert"
          tone={s.pausedForFinding ? 'critical' : undefined}
          value={s.pausedForFinding}
          sub="New findings waiting for the customer"
        />
        <Kpi
          label="Approved today"
          icon="check"
          value={aed(s.approvedValueTodayAed)}
          sub="Booked work, not invoiced"
        />
        <Kpi
          label="Approved this month"
          icon="trend"
          value={aed(s.approvedValueMtdAed)}
          sub="Booked work, not invoiced"
        />
        <Kpi
          label="Delivered this month"
          icon="car"
          value={s.deliveredMtd}
          sub="Cars handed back"
        />
      </div>
      <div className="grid-2 even">
        <Card
          title="Live pipeline"
          action={
            <a className="link" href="#/jobs">
              Open board <Icon name="arrow" size={14} />
            </a>
          }
        >
          <ul className="pipeline">
            {stages.map((x) => (
              <li key={x.key}>
                <span>{x.label}</span>
                <div className="bar thick">
                  <div style={{ width: `${(x.count / max) * 100}%` }} />
                </div>
                <b>{x.count}</b>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="How long cars have been here">
          <div className="donut-wrap">
            <Donut
              center={`${s.activeCars}`}
              caption="cars"
              parts={[
                { value: s.aging.fresh, cls: 'seg-blue', label: '0-3' },
                { value: s.aging.standard, cls: 'seg-sky', label: '4-7' },
                { value: s.aging.delayed, cls: 'seg-yellow', label: '8-14' },
                { value: s.aging.critical, cls: 'seg-red', label: '15+' },
              ]}
            />
            <ul className="legend-list">
              <li>
                <i className="seg-blue" />
                0–3 days<b>{s.aging.fresh}</b>
              </li>
              <li>
                <i className="seg-sky" />
                4–7 days<b>{s.aging.standard}</b>
              </li>
              <li>
                <i className="seg-yellow" />
                8–14 days<b>{s.aging.delayed}</b>
              </li>
              <li>
                <i className="seg-red" />
                15+ days<b>{s.aging.critical}</b>
              </li>
            </ul>
          </div>
        </Card>
      </div>
      <p className="note footnote">
        Sales, margin and enquiry figures appear here once invoicing (Zoho) and the CRM feed are
        connected.
      </p>
    </Page>
  );
}

function Page({
  title,
  eyebrow,
  aside,
  children,
}: {
  title: string;
  eyebrow?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          {eyebrow && <p className="eyebrow">{eyebrow}</p>}
          <h1>{title}</h1>
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

// ---------------- board ----------------
export function LiveBoard() {
  const { state, reload } = useApi(
    () => api<{ jobs: ApiJobSummary[] }>('/api/jobs', { staff: true }),
    'jobs',
    20_000,
  );
  const [q, setQ] = useState('');
  const search = (
    <input
      className="search"
      type="search"
      placeholder="Search plate, customer, job…"
      value={q}
      onChange={(e) => setQ(e.target.value)}
      aria-label="Search jobs"
    />
  );
  if (state.kind === 'loading')
    return (
      <Page title="Job board" aside={search}>
        <Loading />
      </Page>
    );
  if (state.kind === 'error')
    return (
      <Page title="Job board">
        <Problem error={state.error} retry={reload} />
      </Page>
    );
  const jobs = state.data.jobs.filter((j) =>
    `${j.jobNumber} ${j.make} ${j.model} ${j.licensePlate ?? ''} ${j.customerName}`
      .toLowerCase()
      .includes(q.trim().toLowerCase()),
  );
  const cols = STAGES.filter((s) => s.key !== 'delivered');
  return (
    <Page title="Job board" aside={search}>
      <div className="board">
        {cols.map((c) => {
          const list = jobs.filter((j) => j.workStage === c.key);
          return (
            <section key={c.key} className="col" aria-label={c.label}>
              <header>
                <h3>{c.label}</h3>
                <span className="count">{list.length}</span>
              </header>
              <div className="col-body">
                {list.map((j) => {
                  const days = ageDays(j.createdAt);
                  return (
                    <a key={j.id} className={`jcard edge-${ageTone(days)}`} href={`#/jobs/${j.id}`}>
                      <div className="jcard-top">
                        <strong>AVC-{j.jobNumber}</strong>
                        <span className="muted">{days === 0 ? 'Today' : `${days}d`}</span>
                      </div>
                      <div className="jcard-car">
                        {j.make} {j.model}
                      </div>
                      <div className="muted small">
                        {j.customerName} · {j.licensePlate ?? 'No plate'}
                      </div>
                      <div className="jcard-foot">
                        <span className="muted small">{j.responsibleStaffName}</span>
                        {j.awaitingCustomer && (
                          <span className="sev sev-moderate">
                            <i />
                            Awaiting customer
                          </span>
                        )}
                      </div>
                    </a>
                  );
                })}
                {list.length === 0 && <p className="empty small">No cars</p>}
              </div>
            </section>
          );
        })}
      </div>
    </Page>
  );
}

// ---------------- job page ----------------
const STAFF_LABEL: Record<string, (e: ApiJobEvent) => string> = {
  job_created: () => 'Job card created at intake',
  inspection_started: () => 'Inspection started',
  quote_sent: () => 'Quote sent to the customer',
  finding_raised: () => 'New finding raised — work paused on that item',
  customer_link_issued: () => 'Customer tracking link issued',
  quote_decided: (e) =>
    `Customer answered the quote: ${String(e.details.approved ?? 0)} approved, ${String(e.details.rejected ?? 0)} rejected`,
  stage_advanced: (e) => {
    const to = e.toStatus;
    return (
      (
        {
          in_progress: 'Work started',
          quality_check: 'Sent to quality check',
          ready: 'Marked ready for collection',
          delivered: 'Delivered to the customer',
        } as Record<string, string>
      )[to ?? ''] ?? 'Stage advanced'
    );
  },
};

const NEXT: Partial<Record<StageKey, string>> = {
  approved: 'Start work',
  in_bay: 'Send to quality check',
  qc: 'Mark ready',
  ready: 'Mark delivered',
};

export function LiveJob({ id }: { id: string }) {
  const { state, reload } = useApi(
    async () => {
      const [detail, quotes] = await Promise.all([
        api<{ job: ApiJobDetail; events: ApiJobEvent[] }>(`/api/jobs/${id}`, { staff: true }),
        api<{ quotes: ApiQuote[] }>(`/api/jobs/${id}/quotes`, { staff: true }).catch(() => ({
          quotes: [] as ApiQuote[],
        })),
      ]);
      return { ...detail, quotes: quotes.quotes };
    },
    id,
    20_000,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);

  if (state.kind === 'loading')
    return (
      <Page title="Job">
        <Loading />
      </Page>
    );
  if (state.kind === 'error')
    return (
      <Page title="Job">
        <Problem error={state.error} retry={reload} />
      </Page>
    );
  const { job, events, quotes } = state.data;
  const next = NEXT[job.workStage];
  const open = quotes.find((q) => q.status === 'sent');

  async function command(path: string, body: unknown, done?: (r: never) => void) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<never>(path, { method: 'POST', body, staff: true });
      done?.(result);
      reload();
    } catch (e) {
      setMessage({
        tone: 'error',
        text: e instanceof ApiError ? e.message : 'Something went wrong.',
      });
      reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page
      title={`${job.make} ${job.model}`}
      eyebrow={`AVC-${job.jobNumber} · ${job.licensePlate ?? 'No plate'}`}
    >
      <a className="link back" href="#/jobs">
        ← Job board
      </a>
      <Card>
        <Stepper stage={job.workStage} />
        {open?.kind === 'addendum' && (
          <p className="banner banner-critical">
            <Icon name="pause" size={16} /> Work is paused on a new finding until the customer
            decides.
          </p>
        )}
      </Card>
      <div className="grid-2 detail-grid">
        <div className="stack">
          <Card title="Vehicle & customer">
            <dl className="dl">
              <div>
                <dt>Customer</dt>
                <dd>{job.customerName}</dd>
              </div>
              <div>
                <dt>Mobile</dt>
                <dd>{job.customerMobile}</dd>
              </div>
              <div>
                <dt>Vehicle</dt>
                <dd>
                  {job.make} {job.model}
                  {job.vin ? ` · ${job.vin}` : ''}
                </dd>
              </div>
              <div>
                <dt>Mileage</dt>
                <dd>{job.mileageKm.toLocaleString()} km</dd>
              </div>
              <div>
                <dt>Intake condition</dt>
                <dd>{job.intakeCondition}</dd>
              </div>
              <div>
                <dt>Responsible</dt>
                <dd>{job.responsibleStaffName}</dd>
              </div>
              <div>
                <dt>Checked in</dt>
                <dd>{fmtDate(new Date(job.createdAt).getTime())}</dd>
              </div>
            </dl>
          </Card>
          <Card title="Quotes">
            {quotes.length === 0 ? (
              <p className="empty">No quote yet. Quotes are published after the inspection.</p>
            ) : (
              quotes.map((q) => (
                <div key={q.id} style={{ marginBottom: 14 }}>
                  <p className="muted small">
                    Version {q.version} · {q.kind} ·{' '}
                    {q.status === 'sent'
                      ? 'waiting for customer'
                      : `answered ${ago(new Date(q.decidedAt ?? q.sentAt).getTime())}`}{' '}
                    · {aed(q.totalAed, 2)}
                  </p>
                  <ul className="qlist">
                    {q.items.map((i) => (
                      <li key={i.id}>
                        <SeverityBadge level={i.severity} />
                        <span className="q-title">{i.title}</span>
                        <span className="q-price">{aed(i.priceAed)}</span>
                        <span className={`decision d-${i.decision}`}>{i.decision}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </Card>
          <Card title="Actions">
            <div className="actions">
              {job.workStage === 'intake' && (
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() =>
                    command(`/api/jobs/${id}/commands/start-inspection`, {
                      expectedVersion: job.version,
                    })
                  }
                >
                  Start inspection
                </button>
              )}
              {next && (
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || !!open}
                  title={open ? 'Waiting for the customer' : undefined}
                  onClick={() =>
                    command(`/api/jobs/${id}/commands/advance`, { expectedVersion: job.version })
                  }
                >
                  {next}
                </button>
              )}
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                onClick={() =>
                  command(
                    `/api/jobs/${id}/customer-links`,
                    { expectedVersion: job.version },
                    (r: { customerLink: { path: string } }) =>
                      setLink(`${location.origin}${r.customerLink.path}`),
                  )
                }
              >
                <Icon name="link" size={15} /> New customer link
              </button>
            </div>
            {job.workStage === 'inspection' && (
              <p className="note">
                Publishing a quote needs the inspection checklist and photo upload, which are not
                built yet.
              </p>
            )}
            {open && job.workStage === 'quote' && (
              <p className="note">Work cannot start until the customer approves the quote.</p>
            )}
            {link && (
              <p
                className="banner"
                style={{
                  background: 'var(--blue-tint)',
                  color: 'var(--blue-ink)',
                  flexWrap: 'wrap',
                }}
              >
                <span style={{ wordBreak: 'break-all' }}>{link}</span>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => void navigator.clipboard?.writeText(link)}
                >
                  Copy
                </button>
              </p>
            )}
            {link && <p className="note">Shown once. Older links stop working.</p>}
            {message && (
              <p
                className={message.tone === 'error' ? 'banner banner-critical' : 'note'}
                role="alert"
              >
                {message.text}
              </p>
            )}
          </Card>
        </div>
        <Card title="Evidence trail" className="trail-card">
          <Trail
            events={events.map((e) => ({
              id: e.id,
              at: new Date(e.occurredAt).getTime(),
              text: STAFF_LABEL[e.eventType]?.(e) ?? e.eventType.replaceAll('_', ' '),
              meta: e.actorStaffName,
              ref: `EV-${job.jobNumber}-${e.jobVersion}`,
              tone:
                e.eventType === 'finding_raised'
                  ? 'finding'
                  : e.actorType === 'customer'
                    ? 'approval'
                    : undefined,
            }))}
          />
        </Card>
      </div>
    </Page>
  );
}
