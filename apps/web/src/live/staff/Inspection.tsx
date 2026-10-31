import { useState } from 'react';
import { type Photo, EvidenceThumb, PhotoPicker } from '../../ui/evidence';
import type { Severity } from '../../ui/model';
import { Card, Icon, SeverityBadge, ago } from '../../ui/ui';
import { api, uploadEvidence, useApi, type ApiFindingBatch, type ApiQueueJob } from '../api';
import {
  Field,
  Loading,
  Page,
  Problem,
  SeverityPicker,
  messageOf,
  staffFile,
  stageLabel,
  vehicleTitle,
} from './common';

const PRESETS: { group: string; items: string[] }[] = [
  { group: 'Brakes', items: ['Front brake pads', 'Rear brake pads', 'Brake discs', 'Brake fluid'] },
  { group: 'Tyres & wheels', items: ['Tyre wear', 'Tyre damage', 'Wheel alignment'] },
  {
    group: 'Engine & fluids',
    items: ['Engine oil leak', 'Coolant leak', 'Air filter', 'Spark plugs', 'Drive belt'],
  },
  {
    group: 'Suspension & steering',
    items: ['Suspension bushings', 'Shock absorbers', 'Steering play'],
  },
  { group: 'Electrical & AC', items: ['Battery health', 'AC performance', 'Warning light on'] },
  { group: 'Body', items: ['Paint scratch', 'Dent', 'Windscreen chip'] },
];

type Draft = { key: string; title: string; detail: string; severity: Severity; photos: Photo[] };
let draftCounter = 0;
const newDraft = (title = ''): Draft => ({
  key: `d${(draftCounter += 1)}`,
  title,
  detail: '',
  severity: 'moderate',
  photos: [],
});

export function InspectionQueue() {
  const { state, reload } = useApi(
    () => api<{ jobs: ApiQueueJob[] }>('/api/work/queue', { staff: true }),
    'queue',
    20_000,
  );
  if (state.kind === 'loading')
    return (
      <Page title="Cars to inspect">
        <Loading />
      </Page>
    );
  if (state.kind === 'error')
    return (
      <Page title="Cars to inspect">
        <Problem error={state.error} retry={reload} />
      </Page>
    );
  const jobs = state.data.jobs;
  return (
    <Page title="Cars to inspect" eyebrow="Inspection and findings">
      {jobs.length === 0 && <p className="empty">No cars waiting. New ones show up here.</p>}
      <ul className="queue">
        {jobs.map((j) => {
          const toInspect = j.stage === 'inspection';
          const inWork = ['approved', 'in_bay', 'qc'].includes(j.stage);
          return (
            <li key={j.id}>
              <a href={`#/inspect/${j.id}`} className={`qcard ${toInspect ? 'hot' : ''}`}>
                <div className="qcard-top">
                  <strong>
                    {vehicleTitle(j)} · {j.licensePlate ?? 'No plate'}
                  </strong>
                  <span className="muted small">AVC-{j.jobNumber}</span>
                </div>
                <p className="qcard-note">{j.intakeCondition}</p>
                <div className="qcard-foot">
                  <span className="chip">{stageLabel(j.stage)}</span>
                  {j.awaitingPricing && (
                    <span className="sev sev-moderate">
                      <i />
                      With advisor for pricing
                    </span>
                  )}
                  <span className="muted small">{ago(new Date(j.updatedAt).getTime())}</span>
                  <span className="qcard-go">
                    {toInspect ? 'Start inspection' : inWork ? 'Report a finding' : 'View'}
                    <Icon name="arrow" size={14} />
                  </span>
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </Page>
  );
}

export function InspectionCapture({ id }: { id: string }) {
  const queue = useApi(
    () => api<{ jobs: ApiQueueJob[] }>('/api/work/queue', { staff: true }),
    `q-${id}`,
  );
  const earlier = useApi(
    () => api<{ batches: ApiFindingBatch[] }>(`/api/jobs/${id}/findings`, { staff: true }),
    `f-${id}`,
  );
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  if (queue.state.kind === 'loading')
    return (
      <Page title="Inspection">
        <Loading />
      </Page>
    );
  if (queue.state.kind === 'error')
    return (
      <Page title="Inspection">
        <Problem error={queue.state.error} retry={queue.reload} />
      </Page>
    );
  const job = queue.state.data.jobs.find((j) => j.id === id);
  if (!job)
    return (
      <Page title="Inspection">
        <p className="empty">This car is no longer in the inspection queue.</p>
        <a className="link" href="#/inspect">
          Back to the queue
        </a>
      </Page>
    );

  const mode: 'inspect' | 'raise' | 'view' =
    job.stage === 'inspection'
      ? 'inspect'
      : ['approved', 'in_bay', 'qc'].includes(job.stage)
        ? 'raise'
        : 'view';
  const update = (key: string, patch: Partial<Draft>) =>
    setDrafts((d) => d.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const missing = drafts.filter(
    (d) => !d.title.trim() || (d.severity !== 'minor' && d.photos.length === 0),
  );
  const counts = {
    critical: drafts.filter((d) => d.severity === 'critical').length,
    moderate: drafts.filter((d) => d.severity === 'moderate').length,
    minor: drafts.filter((d) => d.severity === 'minor').length,
  };
  const used = new Set(drafts.map((d) => d.title));

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const body = {
        expectedVersion: job!.version,
        findings: drafts.map((d) => ({
          title: d.title.trim(),
          detail: d.detail.trim(),
          severity: d.severity,
          evidenceIds: d.photos.map((p) => p.id),
        })),
      };
      await api(
        mode === 'inspect' ? `/api/jobs/${id}/inspection/submit` : `/api/jobs/${id}/findings`,
        {
          method: 'POST',
          staff: true,
          body,
        },
      );
      setSent(
        mode === 'inspect'
          ? 'Inspection submitted. The customer has been told it is complete, and the advisor is preparing the quote.'
          : 'Finding sent. Work on that item is paused and the advisor will price it for the customer.',
      );
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  if (sent)
    return (
      <Page title="Done">
        <Card>
          <p
            className="banner"
            style={{ background: 'var(--blue-tint)', color: 'var(--blue-ink)' }}
          >
            <Icon name="check" size={16} /> {sent}
          </p>
          <a className="btn primary" href="#/inspect">
            Back to the queue
          </a>
        </Card>
      </Page>
    );

  return (
    <Page
      title={`${vehicleTitle(job)} · ${job.licensePlate ?? 'No plate'}`}
      eyebrow={`AVC-${job.jobNumber} · ${stageLabel(job.stage)} · ${job.mileageKm.toLocaleString()} km`}
    >
      <a className="link back" href="#/inspect">
        ← Queue
      </a>
      <Card title="Why the car is here">
        <p>{job.intakeCondition}</p>
        {earlier.state.kind === 'ready' && earlier.state.data.batches.length > 0 && (
          <details className="earlier">
            <summary>Already reported on this car</summary>
            {earlier.state.data.batches.map((b) => (
              <div key={b.id}>
                <p className="muted small">
                  {b.kind === 'initial' ? 'Inspection' : 'Found during work'} ·{' '}
                  {b.status === 'awaiting_pricing' ? 'with advisor' : 'priced'}
                </p>
                <ul className="mini-list">
                  {b.findings.map((f) => (
                    <li key={f.id}>
                      <SeverityBadge level={f.severity} /> {f.title}
                      {f.evidence.map((e) => (
                        <EvidenceThumb key={e.id} id={e.id} caption={e.caption} load={staffFile} />
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </details>
        )}
      </Card>

      {mode === 'view' && (
        <p className="empty">
          This car is not in a stage where findings can be added ({stageLabel(job.stage)}).
        </p>
      )}

      {mode !== 'view' && (
        <>
          <Card
            title={mode === 'inspect' ? 'Checklist' : 'What did you find?'}
            action={
              <span className="muted small">
                Tap to add. Photos are required for red and yellow.
              </span>
            }
          >
            <div className="presets">
              {PRESETS.map((g) => (
                <div key={g.group}>
                  <h4>{g.group}</h4>
                  <div className="chip-row">
                    {g.items.map((item) => (
                      <button
                        key={item}
                        type="button"
                        className={`chip-btn ${used.has(item) ? 'used' : ''}`}
                        disabled={used.has(item)}
                        onClick={() => setDrafts((d) => [...d, newDraft(item)])}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <button
                type="button"
                className="btn ghost"
                onClick={() => setDrafts((d) => [...d, newDraft()])}
              >
                <Icon name="plus" size={15} /> Something else
              </button>
            </div>
          </Card>

          {drafts.length === 0 && mode === 'inspect' && (
            <p className="empty">
              Nothing added yet. If the car is all clear you can submit with no findings.
            </p>
          )}
          <ul className="drafts">
            {drafts.map((d) => (
              <li key={d.key} className={`draft edge-${d.severity}`}>
                <div className="draft-top">
                  <input
                    className="draft-title"
                    value={d.title}
                    placeholder="What did you find?"
                    onChange={(e) => update(d.key, { title: e.target.value })}
                    aria-label="Finding title"
                  />
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => setDrafts((all) => all.filter((x) => x.key !== d.key))}
                    aria-label="Remove finding"
                  >
                    <Icon name="x" size={14} />
                  </button>
                </div>
                <SeverityPicker
                  value={d.severity}
                  onChange={(severity) => update(d.key, { severity })}
                />
                <Field label="Note for the advisor">
                  <textarea
                    rows={2}
                    value={d.detail}
                    onChange={(e) => update(d.key, { detail: e.target.value })}
                    placeholder="What you measured or saw, in plain words"
                  />
                </Field>
                <PhotoPicker
                  value={d.photos}
                  onChange={(photos) => update(d.key, { photos })}
                  caption={d.title}
                  upload={(file, caption) =>
                    uploadEvidence(id, file, 'photo', caption || 'Finding')
                  }
                  label="Add photo"
                />
                {d.severity !== 'minor' && d.photos.length === 0 && (
                  <p className="note warn">A photo is needed so the customer can see it.</p>
                )}
              </li>
            ))}
          </ul>
          <div className="sticky-bar">
            <div className="tally">
              <span className="sev sev-critical">
                <i />
                {counts.critical}
              </span>
              <span className="sev sev-moderate">
                <i />
                {counts.moderate}
              </span>
              <span className="sev sev-minor">
                <i />
                {counts.minor}
              </span>
            </div>
            {error && (
              <span className="banner banner-critical" role="alert">
                {error}
              </span>
            )}
            <button
              type="button"
              className="btn primary lg"
              disabled={busy || missing.length > 0 || (mode === 'raise' && drafts.length === 0)}
              onClick={send}
            >
              {busy
                ? 'Sending…'
                : mode === 'inspect'
                  ? 'Submit inspection'
                  : 'Send finding to advisor'}
            </button>
          </div>
          {mode === 'inspect' && (
            <p className="note">
              You never see prices. The advisor prices what you report; the customer sees findings
              and prices only after that.
            </p>
          )}
        </>
      )}
    </Page>
  );
}
