// Types and labels shared by the live app and the demo. Contains no sample data.

export type StageKey =
  | 'pickup'
  | 'intake'
  | 'inspection'
  | 'pricing'
  | 'quote'
  | 'approved'
  | 'in_bay'
  | 'qc'
  | 'ready'
  | 'delivered';
export type Severity = 'critical' | 'moderate' | 'minor';
export type Decision = 'pending' | 'approved' | 'rejected';

export const STAGES: { key: StageKey; label: string; customerLabel: string; blurb: string }[] = [
  {
    key: 'pickup',
    label: 'Pickup',
    customerLabel: 'Pickup arranged',
    blurb: 'Our driver will collect your car at the time agreed.',
  },
  {
    key: 'intake',
    label: 'Checked in',
    customerLabel: 'Checked in',
    blurb: 'Your car is with us and photographed from every corner.',
  },
  {
    key: 'inspection',
    label: 'Inspection',
    customerLabel: 'Being inspected',
    blurb: 'Our technician is running the 50-point inspection.',
  },
  {
    key: 'pricing',
    label: 'Preparing quote',
    customerLabel: 'Inspection complete',
    blurb: 'The inspection is done. Your advisor is preparing your quote and will notify you.',
  },
  {
    key: 'quote',
    label: 'Quote ready',
    customerLabel: 'Quote ready for you',
    blurb: 'Review each finding with photos and approve or reject it.',
  },
  {
    key: 'approved',
    label: 'Approved',
    customerLabel: 'Approved — scheduling',
    blurb: 'You approved the work. We are lining up the bay and parts.',
  },
  {
    key: 'in_bay',
    label: 'In bay',
    customerLabel: 'Work in progress',
    blurb: 'Your car is on the lift with our technician.',
  },
  {
    key: 'qc',
    label: 'Quality check',
    customerLabel: 'Final quality check',
    blurb: 'A second pair of eyes is verifying every repair.',
  },
  {
    key: 'ready',
    label: 'Ready',
    customerLabel: 'Ready for you',
    blurb: 'Your car is washed and ready for return.',
  },
  {
    key: 'delivered',
    label: 'Delivered',
    customerLabel: 'Delivered',
    blurb: 'Handed back with your inspection report.',
  },
];
export const stageIndex = (k: StageKey): number => STAGES.findIndex((s) => s.key === k);

export const SEVERITY: Record<Severity, { label: string; hint: string }> = {
  critical: { label: 'Critical', hint: 'Safety or performance risk' },
  moderate: { label: 'Moderate', hint: 'Wearing — address soon' },
  minor: { label: 'Minor', hint: 'Not urgent' },
};

// ---- view models the customer tracker renders, whatever the data source ----
export type TrailEvent = {
  id: string;
  at: number;
  text: string;
  meta?: string;
  ref?: string;
  tone?: 'finding' | 'approval';
  photos?: string[];
};
export type TrackItem = {
  id: string;
  title: string;
  detail: string;
  severity: Severity;
  priceAed: number;
  decision: Decision;
  evidence: { id: string; caption: string }[];
};
export type TrackModel = {
  vehicleTitle: string;
  plate: string;
  stage: StageKey;
  workPaused: boolean;
  advisorName?: string;
  arrivalMethod?: 'pickup' | 'walk_in';
  pendingFinding?: boolean;
  transfer?: {
    direction: 'pickup' | 'return';
    status: 'scheduled' | 'en_route';
    driverName: string | null;
  } | null;
  openQuote: {
    id: string;
    version: number;
    kind: 'initial' | 'addendum';
    items: TrackItem[];
  } | null;
  settled: TrackItem[];
  timeline: TrailEvent[];
};

// A walk-in car never has a pickup step, so it is not shown to the customer.
export const stagesFor = (arrival?: 'pickup' | 'walk_in') =>
  STAGES.filter((s) => s.key !== 'pickup' || arrival === 'pickup');
