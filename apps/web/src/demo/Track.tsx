import type { Decision, TrackItem, TrackModel } from '../ui/model';
import { TrackView } from '../ui/shared';
import { submitDecisions, hasPausedWork, pendingItems, useJob } from './store';
import { toTrail } from './trail';
import type { QuoteItem } from './data';

const asItem = (i: QuoteItem): TrackItem => ({
  id: i.id,
  title: i.title,
  detail: i.detail,
  severity: i.severity,
  priceAed: i.price,
  decision: i.decision,
  evidence: i.photos.map((caption, n) => ({ id: `${i.id}-p${n}`, caption })),
});

// Customer tracker backed by the in-browser sample store.
export function Track({ id }: { id: string }) {
  const job = useJob(id);
  if (!job)
    return (
      <div className="track">
        <p className="empty">We could not find this vehicle. Please check your link.</p>
      </div>
    );
  const pending = pendingItems(job);
  const model: TrackModel = {
    vehicleTitle: `${job.vehicle.year} ${job.vehicle.make} ${job.vehicle.model}`,
    plate: job.vehicle.plate,
    stage: job.stage,
    workPaused: hasPausedWork(job),
    advisorName: job.advisor,
    openQuote:
      pending.length > 0
        ? {
            id: job.id,
            version: 1,
            kind: job.stage === 'quote' ? 'initial' : 'addendum',
            items: pending.map(asItem),
          }
        : null,
    settled: job.items.filter((i) => i.decision !== 'pending').map(asItem),
    timeline: toTrail(job),
  };
  return (
    <TrackView
      model={model}
      onSubmit={(choices: Record<string, Decision>) => submitDecisions(job.id, choices)}
    />
  );
}
