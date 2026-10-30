import type { TrailEvent } from '../ui/model';
import type { Job } from './data';

export function toTrail(job: Job): TrailEvent[] {
  return job.events.map((e) => ({
    id: e.id,
    at: e.at,
    text: e.text,
    meta: `${e.actor} · ${e.role}`,
    ref: `EV-${job.number}-${e.id.split('-e')[1]}`,
    tone: e.kind === 'finding' ? 'finding' : e.kind === 'approval' ? 'approval' : undefined,
    photos: e.photos,
  }));
}
