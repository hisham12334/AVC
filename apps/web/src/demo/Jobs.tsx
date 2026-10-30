import { useState } from 'react';
import { STAGES, stageIndex, type Job } from './data';
import {
  advance,
  approvedTotal,
  canAdvance,
  hasPausedWork,
  isAwaitingCustomer,
  raiseFinding,
  useJob,
  useJobs,
} from './store';
import { Card, Icon, SeverityBadge, ageSeverity, aed, ago, fmtDate } from '../ui/ui';
import { Stepper, Trail } from '../ui/shared';
import { toTrail } from './trail';

function JobCard({ job }: { job: Job }) {
  const sev = ageSeverity(job.ageDays);
  const paused = hasPausedWork(job);
  const waiting = isAwaitingCustomer(job);
  return (
    <a className={`jcard edge-${paused ? 'critical' : sev}`} href={`#/jobs/${job.id}`}>
      <div className="jcard-top">
        <strong>AVC-{job.number}</strong>
        <span className="muted">{job.ageDays === 0 ? 'Today' : `${job.ageDays}d`}</span>
      </div>
      <div className="jcard-car">
        {job.vehicle.make} {job.vehicle.model}
      </div>
      <div className="muted small">
        {job.customer.name} · {job.vehicle.plate}
      </div>
      <div className="jcard-foot">
        <span className="muted small">{job.bay}</span>
        {paused ? (
          <span className="sev sev-critical">
            <i />
            Paused
          </span>
        ) : waiting ? (
          <span className="sev sev-moderate">
            <i />
            Awaiting customer
          </span>
        ) : null}
      </div>
    </a>
  );
}

export function Board() {
  const all = useJobs();
  const [q, setQ] = useState('');
  const jobs = all.filter((j) => {
    const hay =
      `${j.number} ${j.vehicle.make} ${j.vehicle.model} ${j.vehicle.plate} ${j.customer.name}`.toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });
  const cols = STAGES.filter((s) => s.key !== 'delivered');
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">AVC Al Quoz 1</p>
          <h1>Job board</h1>
        </div>
        <input
          className="search"
          type="search"
          placeholder="Search plate, customer, job…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search jobs"
        />
      </div>
      <div className="key">
        <span className="muted small">Card edge shows time in workshop:</span>
        <SeverityBadge level="minor" /> <span className="muted small">under 8 days</span>
        <SeverityBadge level="moderate" /> <span className="muted small">8–14</span>
        <SeverityBadge level="critical" /> <span className="muted small">15+ or paused</span>
      </div>
      <div className="board">
        {cols.map((c) => {
          const list = jobs.filter((j) => j.stage === c.key);
          return (
            <section key={c.key} className="col" aria-label={c.label}>
              <header>
                <h3>{c.label}</h3>
                <span className="count">{list.length}</span>
              </header>
              <div className="col-body">
                {list.map((j) => (
                  <JobCard key={j.id} job={j} />
                ))}
                {list.length === 0 && <p className="empty small">No cars</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function JobDetail({ id }: { id: string }) {
  const job = useJob(id);
  const [copied, setCopied] = useState(false);
  if (!job)
    return (
      <div className="page">
        <p className="empty">Job not found.</p>
        <a className="link" href="#/jobs">
          Back to board
        </a>
      </div>
    );
  const next = canAdvance(job);
  const nextStage = STAGES[stageIndex(job.stage) + 1];
  const trackUrl = `${location.origin}${location.pathname}#/track/${job.id}`;
  return (
    <div className="page">
      <a className="link back" href="#/jobs">
        ← Job board
      </a>
      <div className="page-head">
        <div>
          <p className="eyebrow">
            AVC-{job.number} · {job.packageName}
          </p>
          <h1>
            {job.vehicle.make} {job.vehicle.model}
          </h1>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              void navigator.clipboard?.writeText(trackUrl);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
          >
            <Icon name="link" size={15} /> {copied ? 'Link copied' : 'Copy customer link'}
          </button>
          <a className="btn ghost" href={`#/track/${job.id}`}>
            <Icon name="phone" size={15} /> Customer view
          </a>
        </div>
      </div>

      <Card>
        <Stepper stage={job.stage} />
        {hasPausedWork(job) && (
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
                <dt>Plate</dt>
                <dd>{job.vehicle.plate}</dd>
              </div>
              <div>
                <dt>Vehicle</dt>
                <dd>
                  {job.vehicle.year} {job.vehicle.make} {job.vehicle.model}, {job.vehicle.color}
                </dd>
              </div>
              <div>
                <dt>Customer</dt>
                <dd>
                  {job.customer.name} <span className="chip">{job.customer.segment}</span>
                </dd>
              </div>
              <div>
                <dt>Mobile</dt>
                <dd>{job.customer.mobile}</dd>
              </div>
              <div>
                <dt>Location</dt>
                <dd>{job.bay}</dd>
              </div>
              <div>
                <dt>Advisor / technician</dt>
                <dd>
                  {job.advisor} / {job.technician}
                </dd>
              </div>
              <div>
                <dt>Checked in</dt>
                <dd>
                  {fmtDate(job.createdAt)} ({ago(job.createdAt)})
                </dd>
              </div>
            </dl>
          </Card>

          <Card
            title="Quote"
            action={<span className="muted small">Approved {aed(approvedTotal(job))}</span>}
          >
            {job.items.length === 0 ? (
              <p className="empty">
                {job.inspectionDone > 0
                  ? `Inspection in progress — ${job.inspectionDone} of 50 points checked.`
                  : 'Inspection has not started.'}
              </p>
            ) : (
              <ul className="qlist">
                {job.items.map((i) => (
                  <li key={i.id}>
                    <SeverityBadge level={i.severity} />
                    <span className="q-title">
                      {i.title}
                      {i.addendum && <span className="chip chip-new">New finding</span>}
                    </span>
                    <span className="q-price">{aed(i.price)}</span>
                    <span className={`decision d-${i.decision}`}>{i.decision}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="actions end">
              {job.stage === 'in_bay' && (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={hasPausedWork(job)}
                  onClick={() => raiseFinding(job.id)}
                >
                  <Icon name="plus" size={15} /> Raise new finding
                </button>
              )}
              <button
                type="button"
                className="btn primary"
                disabled={!next.ok}
                onClick={() => advance(job.id)}
                title={next.reason}
              >
                {nextStage ? `Move to ${nextStage.label}` : 'Done'}
              </button>
            </div>
            {!next.ok && next.reason && <p className="note">{next.reason}.</p>}
          </Card>
        </div>

        <Card title="Evidence trail" className="trail-card">
          <Trail events={toTrail(job)} />
        </Card>
      </div>
    </div>
  );
}
