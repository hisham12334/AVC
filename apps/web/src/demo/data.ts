// Sample data for the demo experience. Nothing here is a real customer record.
// KPI figures mirror the client's Daily KPI report dated 27-Oct-2026.

import {
  STAGES,
  SEVERITY,
  stageIndex,
  type Decision,
  type Severity,
  type StageKey,
} from '../ui/model';
export { STAGES, SEVERITY, stageIndex };
export type { Decision, Severity, StageKey };
export type Kind = 'service' | 'brakes' | 'body' | 'tune';

export type QuoteItem = {
  id: string;
  title: string;
  detail: string;
  severity: Severity;
  price: number;
  photos: string[];
  decision: Decision;
  addendum?: boolean;
};

export type EventKind =
  | 'checkin'
  | 'photos'
  | 'inspection'
  | 'quote'
  | 'approval'
  | 'work'
  | 'finding'
  | 'qc'
  | 'ready'
  | 'delivery';

export type JobEvent = {
  id: string;
  at: number;
  actor: string;
  role: 'Advisor' | 'Technician' | 'Driver' | 'Customer' | 'Supervisor' | 'System';
  kind: EventKind;
  text: string;
  photos?: string[];
};

export type Job = {
  id: string;
  number: number;
  branchId: string;
  stage: StageKey;
  kind: Kind;
  createdAt: number;
  ageDays: number;
  customer: { name: string; mobile: string; segment: 'Private' | 'Corporate' };
  vehicle: { make: string; model: string; year: number; color: string; plate: string };
  packageName: string;
  advisor: string;
  technician: string;
  bay: string;
  inspectionDone: number;
  items: QuoteItem[];
  events: JobEvent[];
};

export const BRANCHES = [{ id: 'alquoz', name: 'Al Quoz 1', city: 'Dubai' }];

const H = 3_600_000;
const D = 24 * H;

type ItemSeed = [string, string, Severity, number, string[]];
const ITEMS: Record<Kind, ItemSeed[]> = {
  service: [
    [
      'Engine oil & OEM filter',
      'Synthetic oil change with OEM-spec filter.',
      'minor',
      420,
      ['Oil sample'],
    ],
    [
      'Brake fluid flush',
      'Fluid moisture above the safe limit at 3.4%.',
      'moderate',
      310,
      ['Moisture test strip'],
    ],
    [
      'Cabin & engine air filters',
      'Both filters clogged with road dust.',
      'minor',
      260,
      ['Filter comparison'],
    ],
    [
      'Wiper blades',
      'Streaking and edge cracking on the driver side.',
      'moderate',
      140,
      ['Blade close-up'],
    ],
  ],
  brakes: [
    [
      'Front brake pads',
      'Pad material measured at 2.8 mm. Minimum safe is 3 mm.',
      'critical',
      780,
      ['Pad thickness gauge', 'Caliper view'],
    ],
    [
      'Front brake discs',
      'Hairline cracking near the disc edge.',
      'critical',
      1250,
      ['Disc crack macro'],
    ],
    ['Rear brake pads', 'Pads at 4.5 mm and wearing evenly.', 'moderate', 520, ['Rear pad gauge']],
    [
      'Wheel alignment',
      'Slight toe-in drift, uneven tyre wear starting.',
      'minor',
      180,
      ['Alignment readout'],
    ],
  ],
  body: [
    [
      'Rear bumper respray',
      'Deep scratch through clear coat across the lower bumper.',
      'moderate',
      1450,
      ['Bumper scratch', 'Panel angle'],
    ],
    [
      'Dent removal, driver door',
      'Paintless dent repair possible — no repaint needed.',
      'minor',
      450,
      ['Door dent'],
    ],
    ['Post-paint polish', 'Blend and polish the repaired panel.', 'minor', 220, ['Panel finish']],
  ],
  tune: [
    [
      'Spark plugs',
      'Electrode wear above tolerance on 3 of 6 plugs.',
      'moderate',
      640,
      ['Plug comparison'],
    ],
    [
      'Throttle body cleaning',
      'Heavy carbon build-up restricting airflow.',
      'minor',
      260,
      ['Throttle plate'],
    ],
    ['Fuel injector additive', 'Preventive injector cleaning.', 'minor', 180, []],
    [
      'Battery & AC performance',
      'Battery at 61% health; AC output below spec.',
      'moderate',
      420,
      ['Battery test report'],
    ],
  ],
};

export function quoteItems(kind: Kind, jobId: string): QuoteItem[] {
  return ITEMS[kind].map((it, i) => ({
    id: `${jobId}-i${i + 1}`,
    title: it[0],
    detail: it[1],
    severity: it[2],
    price: it[3],
    photos: it[4],
    decision: 'pending' as Decision,
  }));
}

type Seed = {
  n: number;
  stage: StageKey;
  age: number;
  kind: Kind;
  customer: [string, string, 'Private' | 'Corporate'];
  car: [string, string, number, string, string];
  pkg: string;
  bay: string;
  advisor: string;
  tech: string;
};

const SEEDS: Seed[] = [
  {
    n: 1054,
    stage: 'intake',
    age: 0,
    kind: 'service',
    customer: ['Omar Al Suwaidi', '+971 50 612 4408', 'Private'],
    car: ['Porsche', 'Macan S', 2021, 'Chalk', 'Dubai A 48213'],
    pkg: 'Full Care Major Minor Service',
    bay: 'Parking 12',
    advisor: 'Rania',
    tech: 'Unassigned',
  },
  {
    n: 1053,
    stage: 'intake',
    age: 0,
    kind: 'brakes',
    customer: ['Sara Whitfield', '+971 55 903 1182', 'Private'],
    car: ['Range Rover', 'Sport', 2020, 'Santorini Black', 'Dubai R 7731'],
    pkg: 'Safety & Stop Bundle',
    bay: 'Parking 07',
    advisor: 'Rania',
    tech: 'Unassigned',
  },
  {
    n: 1052,
    stage: 'inspection',
    age: 0,
    kind: 'tune',
    customer: ['Meridian Facilities LLC', '+971 4 339 8800', 'Corporate'],
    car: ['Lexus', 'LX 570', 2019, 'Pearl White', 'Dubai K 20456'],
    pkg: 'All-In-One Tune-Up',
    bay: 'Lift 2',
    advisor: 'Yousef',
    tech: 'Imran K.',
  },
  {
    n: 1051,
    stage: 'inspection',
    age: 1,
    kind: 'service',
    customer: ['Daniel Haddad', '+971 56 441 7730', 'Private'],
    car: ['BMW', '520i', 2022, 'Alpine White', 'Dubai D 9012'],
    pkg: 'Full Care Major Minor Service',
    bay: 'Lift 1',
    advisor: 'Yousef',
    tech: 'Tariq M.',
  },
  {
    n: 1050,
    stage: 'quote',
    age: 1,
    kind: 'brakes',
    customer: ['Noura Al Falasi', '+971 52 288 9054', 'Private'],
    car: ['Porsche', 'Cayenne', 2020, 'Carrara White', 'Dubai B 31870'],
    pkg: 'Safety & Stop Bundle',
    bay: 'Parking 03',
    advisor: 'Rania',
    tech: 'Imran K.',
  },
  {
    n: 1049,
    stage: 'quote',
    age: 2,
    kind: 'service',
    customer: ['James Okafor', '+971 54 770 2216', 'Private'],
    car: ['Mercedes-Benz', 'C300', 2021, 'Obsidian Black', 'Dubai C 6104'],
    pkg: 'Full Care Major Minor Service',
    bay: 'Parking 09',
    advisor: 'Yousef',
    tech: 'Tariq M.',
  },
  {
    n: 1048,
    stage: 'quote',
    age: 2,
    kind: 'tune',
    customer: ['Priya Raman', '+971 50 129 6643', 'Private'],
    car: ['Audi', 'Q7', 2019, 'Daytona Grey', 'Dubai F 55290'],
    pkg: 'All-In-One Tune-Up',
    bay: 'Parking 15',
    advisor: 'Rania',
    tech: 'Imran K.',
  },
  {
    n: 1047,
    stage: 'approved',
    age: 3,
    kind: 'body',
    customer: ['Khalid Al Mansoori', '+971 55 612 0071', 'Private'],
    car: ['Mercedes-Benz', 'GLE 450', 2022, 'Selenite Grey', 'Dubai M 11938'],
    pkg: 'Express Refresh Panel Touch-Up',
    bay: 'Paint booth queue',
    advisor: 'Yousef',
    tech: 'Waleed S.',
  },
  {
    n: 1046,
    stage: 'ready',
    age: 3,
    kind: 'service',
    customer: ['Elena Petrova', '+971 58 330 4419', 'Private'],
    car: ['BMW', 'X5', 2020, 'Phytonic Blue', 'Dubai E 80317'],
    pkg: 'Full Care Major Minor Service',
    bay: 'Wash bay',
    advisor: 'Rania',
    tech: 'Tariq M.',
  },
  {
    n: 1044,
    stage: 'in_bay',
    age: 5,
    kind: 'brakes',
    customer: ['Harbour Real Estate', '+971 4 552 1010', 'Corporate'],
    car: ['Lexus', 'ES 350', 2021, 'Silver', 'Dubai J 40182'],
    pkg: 'Safety & Stop Bundle',
    bay: 'Lift 3',
    advisor: 'Yousef',
    tech: 'Imran K.',
  },
  {
    n: 1042,
    stage: 'ready',
    age: 6,
    kind: 'tune',
    customer: ['Faisal Qureshi', '+971 56 904 7721', 'Private'],
    car: ['Audi', 'A6', 2018, 'Navarra Blue', 'Dubai G 2276'],
    pkg: 'All-In-One Tune-Up',
    bay: 'Parking 21',
    advisor: 'Rania',
    tech: 'Tariq M.',
  },
  {
    n: 1031,
    stage: 'in_bay',
    age: 16,
    kind: 'body',
    customer: ['Alessandro Greco', '+971 50 884 3302', 'Private'],
    car: ['Porsche', '911 Carrera', 2019, 'Guards Red', 'Dubai A 100'],
    pkg: 'Full Panel Restoration',
    bay: 'Paint booth',
    advisor: 'Rania',
    tech: 'Waleed S.',
  },
  {
    n: 1028,
    stage: 'in_bay',
    age: 18,
    kind: 'body',
    customer: ['Hessa Al Ketbi', '+971 55 276 1904', 'Private'],
    car: ['Land Rover', 'Defender 110', 2022, 'Pangea Green', 'Dubai N 6620'],
    pkg: 'Bumper & Door Repair',
    bay: 'Parking 18',
    advisor: 'Yousef',
    tech: 'Waleed S.',
  },
  {
    n: 1024,
    stage: 'in_bay',
    age: 21,
    kind: 'body',
    customer: ['Tomas Berg', '+971 52 018 9940', 'Private'],
    car: ['BMW', 'M3', 2020, 'Isle of Man Green', 'Dubai H 3345'],
    pkg: 'Full Panel Restoration',
    bay: 'Parking 25',
    advisor: 'Rania',
    tech: 'Waleed S.',
  },
  {
    n: 1019,
    stage: 'qc',
    age: 24,
    kind: 'body',
    customer: ['Aisha Bin Hammad', '+971 50 700 5512', 'Private'],
    car: ['Mercedes-Benz', 'S 500', 2018, 'Diamond White', 'Dubai L 9087'],
    pkg: 'Express Refresh Panel Touch-Up',
    bay: 'Lift 3',
    advisor: 'Yousef',
    tech: 'Waleed S.',
  },
];

function buildJob(s: Seed, now: number): Job {
  const idx = stageIndex(s.stage);
  const id = `j-${s.n}`;
  const t0 = now - s.age * D - 3 * H;
  const span = now - t0;
  const at = (f: number) => Math.round(t0 + span * f);
  const hasItems = idx >= stageIndex('quote');
  const items: QuoteItem[] = hasItems
    ? ITEMS[s.kind].map((it, i) => {
        const approvedPhase = idx >= stageIndex('approved');
        const rejected = approvedPhase && i === ITEMS[s.kind].length - 1 && s.kind !== 'body';
        return {
          id: `${id}-i${i + 1}`,
          title: it[0],
          detail: it[1],
          severity: it[2],
          price: it[3],
          photos: it[4],
          decision: approvedPhase ? (rejected ? 'rejected' : 'approved') : 'pending',
        };
      })
    : [];

  const E: JobEvent[] = [];
  const push = (
    f: number,
    actor: string,
    role: JobEvent['role'],
    kind: EventKind,
    text: string,
    photos?: string[],
  ) => E.push({ id: `${id}-e${E.length + 1}`, at: at(f), actor, role, kind, text, photos });

  push(0, s.advisor, 'Advisor', 'checkin', 'Vehicle checked in at AVC Al Quoz 1.');
  push(0.03, s.advisor, 'Advisor', 'photos', 'Intake photos logged with mileage and fuel level.', [
    'Front left',
    'Front right',
    'Rear left',
    'Rear right',
  ]);
  if (idx >= 1)
    push(0.1, s.tech, 'Technician', 'inspection', 'Digital inspection started on the tablet.');
  if (idx >= 2) {
    const flagged = items.filter((i) => i.severity !== 'minor').length;
    push(
      0.22,
      s.tech,
      'Technician',
      'inspection',
      `50-point inspection complete. ${flagged} item${flagged === 1 ? '' : 's'} need attention.`,
      items.flatMap((i) => i.photos).slice(0, 4),
    );
    push(0.25, s.advisor, 'Advisor', 'quote', `Quote sent to customer for ${items.length} items.`);
  }
  if (idx >= 3) {
    const kept = items.filter((i) => i.decision === 'approved').length;
    push(
      0.34,
      s.customer[0],
      'Customer',
      'approval',
      `Customer approved ${kept} of ${items.length} items. Work authorised.`,
    );
  }
  if (idx >= 4) push(0.5, s.tech, 'Technician', 'work', `Work started in ${s.bay}.`);
  if (idx >= 5)
    push(0.85, s.tech, 'Technician', 'work', 'Repairs complete. Sent to quality check.');
  if (idx >= 6)
    push(0.95, 'Supervisor', 'Supervisor', 'qc', 'Quality check passed. Vehicle washed.', [
      'Finished panel',
      'Final road test log',
    ]);

  return {
    id,
    number: s.n,
    branchId: 'alquoz',
    stage: s.stage,
    kind: s.kind,
    createdAt: t0,
    ageDays: s.age,
    customer: { name: s.customer[0], mobile: s.customer[1], segment: s.customer[2] },
    vehicle: {
      make: s.car[0],
      model: s.car[1],
      year: s.car[2],
      color: s.car[3],
      plate: s.car[4],
    },
    packageName: s.pkg,
    advisor: s.advisor,
    technician: s.tech,
    bay: s.bay,
    inspectionDone: idx >= 2 ? 50 : idx === 1 ? 23 : 0,
    items,
    events: E,
  };
}

export function seedJobs(now = Date.now()): Job[] {
  return SEEDS.map((s) => buildJob(s, now));
}

export const ADDENDUM_TEMPLATE = {
  title: 'Cracked serpentine belt',
  detail:
    'Found while the engine bay was open: visible cracking across the drive belt. Replacing it now avoids a breakdown.',
  severity: 'moderate' as Severity,
  price: 380,
  photos: ['Belt close-up', 'Pulley alignment'],
};

// ---- KPI figures from the client's Daily KPI report (27-Oct-2026) ----
export const KPI = {
  reportDate: '27 Oct 2026',
  day: 27,
  daysInMonth: 31,
  target: 500_000,
  grossSales: 95_213.75,
  grossProfit: 34_936.36,
  gpMargin: 36.69,
  remaining: 404_786.25,
  runRate: 3_526,
  projection: 109_319.49,
  atv: 726.82,
  atvTarget: 1_350,
  deliveredMtd: 131,
  cycleDays: 9.8,
  cycleTarget: 7,
  capacity: 30,
  reviews: 0,
  reviewsTarget: 50,
  complaints: 0,
  funnel: {
    enquiries: 57,
    converted: 4,
    rate: 7.02,
    activeDialog: 21,
    followUp: 15,
    pendingContact: 6,
  },
  departments: [
    { name: 'Mechanical', sales: 52_970.17, cogs: 51_968.51 },
    { name: 'Bodyshop', sales: 26_542.68, cogs: 4_233.64 },
    { name: 'Spare parts', sales: 14_147.09, cogs: 1_503.81 },
    { name: 'Labor charge', sales: 1_553.81, cogs: 2_571.43 },
  ],
};

// Cumulative month-to-date revenue for the chart, scaled so the last point equals gross sales.
export function dailyRevenue(): number[] {
  const weights = [
    0.8, 1.1, 0.9, 1.2, 1.0, 0.7, 0.4, 1.3, 1.1, 1.0, 1.2, 0.9, 0.6, 0.5, 1.2, 1.0, 1.1, 1.3, 0.9,
    0.6, 0.4, 1.0, 1.2, 1.1, 0.9, 1.0, 0.8,
  ];
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return weights.map((w) => {
    acc += (w / total) * KPI.grossSales;
    return acc;
  });
}
