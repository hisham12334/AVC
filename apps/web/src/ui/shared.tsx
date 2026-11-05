import { useState } from 'react';
import {
  SEVERITY,
  STAGES,
  stageIndex,
  stagesFor,
  type Decision,
  type StageKey,
  type TrackModel,
  type TrailEvent,
} from './model';
import { EvidenceThumb, type Loader } from './evidence';
import { Icon, SeverityBadge, aed, fmtDate } from './ui';

export function Stepper({ stage, arrival }: { stage: StageKey; arrival?: 'pickup' | 'walk_in' }) {
  const steps = stagesFor(arrival);
  const cur = steps.findIndex((s) => s.key === stage);
  return (
    <ol
      className="stepper"
      aria-label="Job progress"
      style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
    >
      {steps.map((s, i) => (
        <li
          key={s.key}
          className={i < cur ? 'done' : i === cur ? 'now' : ''}
          aria-current={i === cur ? 'step' : undefined}
        >
          <span className="dot">{i < cur ? <Icon name="check" size={12} /> : i + 1}</span>
          <span className="lbl">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

export function Thumbs({
  photos,
  load,
}: {
  photos: { id: string; caption: string }[];
  load?: Loader;
}) {
  if (photos.length === 0) return null;
  return (
    <div className="thumbs">
      {photos.map((p) => (
        <EvidenceThumb key={p.id} id={p.id} caption={p.caption} load={load} />
      ))}
    </div>
  );
}

// Newest first. Every entry is time-stamped and says who did it, which is the point of the trail.
export function Trail({ events }: { events: TrailEvent[] }) {
  const sorted = [...events].sort((a, b) => b.at - a.at);
  return (
    <ol className="trail">
      {sorted.map((e) => (
        <li key={e.id} className={`ev ${e.tone ? `ev-${e.tone}` : ''}`}>
          <span className="ev-dot" />
          <div>
            <div className="ev-top">
              <strong>{e.text}</strong>
            </div>
            <div className="ev-meta">
              {e.meta && <span>{e.meta}</span>}
              <time>{fmtDate(e.at)}</time>
              {e.ref && (
                <span className="ev-lock">
                  <Icon name="lock" size={11} /> {e.ref}
                </span>
              )}
            </div>
            {e.photos && (
              <Thumbs photos={e.photos.map((caption, i) => ({ id: `${e.id}-${i}`, caption }))} />
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export type SubmitState = { busy: boolean; error?: string };

// The customer tracker. It renders a TrackModel and knows nothing about where the data came from.
export function TrackView({
  model,
  onSubmit,
  state = { busy: false },
  loadEvidence,
  billHref,
}: {
  model: TrackModel;
  loadEvidence?: Loader;
  billHref?: string;
  onSubmit: (choices: Record<string, Decision>) => void | boolean | Promise<void | boolean>;
  state?: SubmitState;
}) {
  const [draft, setDraft] = useState<Record<string, Decision>>({});
  const steps = stagesFor(model.arrivalMethod ?? 'walk_in');
  const stage = STAGES[stageIndex(model.stage)]!;
  const cur = Math.max(
    0,
    steps.findIndex((s) => s.key === model.stage),
  );
  const open = model.openQuote;
  const toDecide = open?.items ?? [];
  const isAddendum = open?.kind === 'addendum';
  const decided = toDecide.filter((i) => draft[i.id]).length;
  const draftApproved = toDecide
    .filter((i) => draft[i.id] === 'approved')
    .reduce((a, i) => a + Math.round(i.priceAed * 100), 0);
  const settledApproved = model.settled
    .filter((i) => i.decision === 'approved')
    .reduce((a, i) => a + Math.round(i.priceAed * 100), 0);

  return (
    <div className="track">
      <header className="t-hero">
        <div className="t-brand">
          <span className="brand-mark">AVC</span>
          <span>Garage &amp; Bodyshop</span>
          <span className="live">
            <i /> Live
          </span>
        </div>
        <p className="t-car">{model.vehicleTitle}</p>
        <p className="t-plate">{model.plate}</p>
        <h1>{model.workPaused ? 'Work paused — your decision needed' : stage.customerLabel}</h1>
        <p className="t-blurb">
          {model.workPaused
            ? 'Our technician found something new. We will not touch it until you decide.'
            : stage.blurb}
        </p>
        <div
          className="t-progress"
          role="progressbar"
          aria-label="Service progress"
          aria-valuemin={1}
          aria-valuemax={steps.length}
          aria-valuenow={cur + 1}
        >
          {steps.map((s, i) => (
            <span key={s.key} className={i <= cur ? 'on' : ''} />
          ))}
        </div>
        <p className="t-step">
          Step {cur + 1} of {steps.length} · {stage.label}
        </p>
      </header>

      <main className="t-body">
        {model.transfer && (
          <section className="t-card" aria-label="Driver">
            <h2>{model.transfer.direction === 'pickup' ? 'Your pickup' : 'Your delivery'}</h2>
            <p className="muted">
              {model.transfer.status === 'en_route'
                ? `${model.transfer.driverName ?? 'Our driver'} is on the way.`
                : model.transfer.driverName
                  ? `${model.transfer.driverName} is assigned and will set off at the agreed time.`
                  : 'A driver will be assigned shortly.'}
            </p>
          </section>
        )}
        {model.pendingFinding && (
          <section className="t-card t-decide" aria-label="New finding">
            <h2>A new finding is being priced</h2>
            <p className="muted">
              Our technician spotted something new. We have paused work on it, and your advisor is
              preparing the price. You will be asked to approve or reject it before we do anything.
            </p>
          </section>
        )}
        {open && (
          <section className="t-card t-decide" aria-label="Your decision">
            <div className="t-card-head">
              <h2>{isAddendum ? 'New finding to review' : 'Your quote'}</h2>
              <span className="muted small">
                {decided} of {toDecide.length} decided
              </span>
            </div>
            <p className="muted small">
              {isAddendum
                ? 'A quick yes or no. Work on this item stays paused until you answer.'
                : 'Approve or reject each item. We only start the work you approve.'}
            </p>
            <ul className="t-items">
              {toDecide.map((i) => {
                const d = draft[i.id];
                return (
                  <li key={i.id} className={`t-item edge-${i.severity} ${d ? `is-${d}` : ''}`}>
                    <div className="t-item-top">
                      <SeverityBadge level={i.severity} />
                      <strong>{aed(i.priceAed)}</strong>
                    </div>
                    <h3>{i.title}</h3>
                    {i.detail && <p>{i.detail}</p>}
                    <p className="muted small">{SEVERITY[i.severity].hint}</p>
                    <Thumbs photos={i.evidence} load={loadEvidence} />
                    <div className="seg-btns" role="group" aria-label={`Decision for ${i.title}`}>
                      <button
                        type="button"
                        className={d === 'rejected' ? 'rej on' : 'rej'}
                        aria-pressed={d === 'rejected'}
                        onClick={() => setDraft((d) => ({ ...d, [i.id]: 'rejected' }))}
                      >
                        <Icon name="x" size={16} /> Reject
                      </button>
                      <button
                        type="button"
                        className={d === 'approved' ? 'app on' : 'app'}
                        aria-pressed={d === 'approved'}
                        onClick={() => setDraft((d) => ({ ...d, [i.id]: 'approved' }))}
                      >
                        <Icon name="check" size={16} /> Approve
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="t-submit">
              <div>
                <span className="muted small">Approved so far</span>
                <strong>{aed(draftApproved / 100)}</strong>
              </div>
              <button
                type="button"
                className="btn primary lg"
                disabled={decided < toDecide.length || state.busy}
                onClick={async () => {
                  // Keep the customer's choices on screen if saving failed.
                  if ((await onSubmit(draft)) !== false) setDraft({});
                }}
              >
                {state.busy ? 'Saving…' : isAddendum ? 'Confirm decision' : 'Confirm & start work'}
              </button>
            </div>
            {state.error && (
              <p className="banner banner-critical" role="alert">
                {state.error}
              </p>
            )}
            <p className="note">
              <Icon name="shield" size={13} /> Your approval is recorded with the time and kept as
              evidence. Nothing is added without asking you first.
            </p>
          </section>
        )}

        <section className="t-card" aria-label="Journey">
          <h2>Your car&rsquo;s journey</h2>
          <ol className="journey">
            {steps.map((s, i) => (
              <li
                key={s.key}
                className={i < cur ? 'done' : i === cur ? 'now' : ''}
                aria-current={i === cur ? 'step' : undefined}
              >
                <span className="j-dot">{i < cur ? <Icon name="check" size={12} /> : ''}</span>
                <div>
                  <strong>{s.customerLabel}</strong>
                  {i === cur && <p className="muted small">{s.blurb}</p>}
                </div>
              </li>
            ))}
          </ol>
        </section>

        {billHref && (
          <a className="t-card bill-link" href={billHref}>
            <Icon name="list" size={18} />
            <span>
              <strong>View your bill</strong>
              <small className="muted">Itemised, with photos and what happens next</small>
            </span>
            <Icon name="arrow" size={16} />
          </a>
        )}

        {model.settled.length > 0 && (
          <section className="t-card" aria-label="Approved work">
            <div className="t-card-head">
              <h2>Your approved work</h2>
              <strong>{aed(settledApproved / 100)}</strong>
            </div>
            <ul className="qlist plain">
              {model.settled.map((i) => (
                <li key={i.id}>
                  <SeverityBadge level={i.severity} />
                  <span className="q-title">{i.title}</span>
                  <span className={`decision d-${i.decision}`}>{i.decision}</span>
                  <span className="q-price">{aed(i.priceAed)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="t-card" aria-label="Updates and evidence">
          <h2>Updates &amp; proof</h2>
          <p className="muted small">
            Every update is time-stamped with who did it. Photos are kept for your records.
          </p>
          <Trail events={model.timeline} />
        </section>

        <footer className="t-foot">
          <div>
            <strong>
              {model.advisorName ? `Your advisor: ${model.advisorName}` : 'AVC Garage'}
            </strong>
            <span className="muted small">12-month / 20,000 km warranty on repairs and parts</span>
          </div>
          <a className="btn ghost" href="tel:+97140000000">
            <Icon name="phone" size={15} /> Call
          </a>
        </footer>
      </main>
    </div>
  );
}
