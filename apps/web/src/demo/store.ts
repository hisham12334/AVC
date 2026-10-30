import { useSyncExternalStore } from 'react';
import {
  ADDENDUM_TEMPLATE,
  STAGES,
  quoteItems,
  seedJobs,
  stageIndex,
  type Decision,
  type Job,
  type JobEvent,
  type EventKind,
} from './data';

// In-memory store shared by the admin and customer views, so a customer's approval is
// immediately visible on the admin board. State resets on reload.
let jobs: Job[] = seedJobs();
const listeners = new Set<() => void>();

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function commit(next: Job[]): void {
  jobs = next;
  listeners.forEach((l) => l());
}
function update(id: string, fn: (j: Job) => Job): void {
  commit(jobs.map((j) => (j.id === id ? fn(j) : j)));
}
function withEvent(
  j: Job,
  role: JobEvent['role'],
  actor: string,
  kind: EventKind,
  text: string,
  photos?: string[],
): Job {
  const ev: JobEvent = {
    id: `${j.id}-e${j.events.length + 1}`,
    at: Date.now(),
    actor,
    role,
    kind,
    text,
    photos,
  };
  return { ...j, events: [...j.events, ev] };
}

export const useJobs = (): Job[] => useSyncExternalStore(subscribe, () => jobs);
export const useJob = (id: string): Job | undefined => useJobs().find((j) => j.id === id);

export const pendingItems = (j: Job) => j.items.filter((i) => i.decision === 'pending');
export const isAwaitingCustomer = (j: Job): boolean => pendingItems(j).length > 0;
export const hasPausedWork = (j: Job): boolean =>
  j.stage === 'in_bay' && j.items.some((i) => i.addendum && i.decision === 'pending');
export const approvedTotal = (j: Job): number =>
  j.items.filter((i) => i.decision === 'approved').reduce((a, i) => a + i.price, 0);

export function submitDecisions(jobId: string, choices: Record<string, Decision>): void {
  update(jobId, (current) => {
    const j = {
      ...current,
      items: current.items.map((i) => (choices[i.id] ? { ...i, decision: choices[i.id] } : i)),
    };
    if (pendingItems(j).length > 0) return current;
    if (current.stage !== 'quote') {
      const item = j.items.filter((i) => i.addendum).at(-1);
      const approved = item?.decision === 'approved';
      return withEvent(
        j,
        'Customer',
        j.customer.name,
        'approval',
        approved
          ? `Customer approved the new finding "${item?.title}". Work resumed.`
          : `Customer declined the new finding "${item?.title}". Work continues on approved items.`,
      );
    }
    const kept = j.items.filter((i) => i.decision === 'approved').length;
    if (kept === 0) {
      return {
        ...withEvent(
          j,
          'Customer',
          j.customer.name,
          'approval',
          'Customer declined all repairs. Vehicle ready for collection.',
        ),
        stage: 'ready',
      };
    }
    return {
      ...withEvent(
        j,
        'Customer',
        j.customer.name,
        'approval',
        `Customer approved ${kept} of ${j.items.length} items. Work authorised.`,
      ),
      stage: 'approved',
    };
  });
}

export function raiseFinding(jobId: string): void {
  update(jobId, (j) => {
    if (j.stage !== 'in_bay' || hasPausedWork(j)) return j;
    const item = {
      ...ADDENDUM_TEMPLATE,
      id: `${j.id}-a${j.items.length + 1}`,
      decision: 'pending' as Decision,
      addendum: true,
    };
    return withEvent(
      { ...j, items: [...j.items, item] },
      'Technician',
      j.technician,
      'finding',
      `New finding: ${item.title}. Work paused on this item until the customer decides.`,
      item.photos,
    );
  });
}

export const canAdvance = (j: Job): { ok: boolean; reason?: string } => {
  if (j.stage === 'delivered') return { ok: false, reason: 'Already delivered' };
  if (j.stage === 'quote') return { ok: false, reason: 'Waiting for the customer to approve' };
  if (hasPausedWork(j)) return { ok: false, reason: 'Work paused — new finding awaiting approval' };
  return { ok: true };
};

export function advance(jobId: string): void {
  update(jobId, (j) => {
    if (!canAdvance(j).ok) return j;
    const next = STAGES[stageIndex(j.stage) + 1];
    if (!next) return j;
    const text: Record<string, string> = {
      inspection: 'Digital inspection started.',
      quote: 'Inspection complete. Quote sent to the customer.',
      in_bay: `Work started in ${j.bay}.`,
      qc: 'Repairs complete. Sent to quality check.',
      ready: 'Quality check passed. Vehicle washed and ready.',
      delivered: 'Vehicle delivered to customer with inspection report.',
    };
    const kind: EventKind =
      next.key === 'qc'
        ? 'qc'
        : next.key === 'ready'
          ? 'ready'
          : next.key === 'delivered'
            ? 'delivery'
            : next.key === 'quote'
              ? 'quote'
              : 'work';
    const items = next.key === 'quote' && j.items.length === 0 ? quoteItems(j.kind, j.id) : j.items;
    return {
      ...withEvent(
        { ...j, items },
        'Advisor',
        j.advisor,
        kind,
        text[next.key] ?? `Moved to ${next.label}.`,
      ),
      stage: next.key,
      inspectionDone: next.key === 'quote' ? 50 : j.inspectionDone,
    };
  });
}

export function resetDemo(): void {
  commit(seedJobs());
}
