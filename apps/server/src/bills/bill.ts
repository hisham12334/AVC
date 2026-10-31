import type { Pool, PoolClient } from 'pg';
import { AppError } from '../errors.js';
import { loadQuotes } from '../quotes/queries.js';

export type Bill = {
  document: 'estimate' | 'invoice';
  number: string;
  issuedAt: string;
  business: { name: string; branch: string };
  customer: { name: string; email: string | null; mobile: string };
  vehicle: { title: string; plate: string | null; vin: string | null; mileageKm: number };
  advisor: string;
  stage: string;
  lines: {
    position: number;
    title: string;
    detail: string;
    severity: 'critical' | 'moderate' | 'minor';
    priceAed: number;
    decision: 'pending' | 'approved' | 'rejected';
    quoteVersion: number;
    kind: 'initial' | 'addendum';
    evidenceCount: number;
  }[];
  totals: { quotedAed: number; approvedAed: number; declinedAed: number };
  paymentStatus: 'due_on_delivery' | 'received' | 'reversed';
  instructions: string[];
  terms: string[];
};

type JobRow = {
  jobNumber: string;
  stage: string;
  mileageKm: number;
  customerName: string;
  email: string | null;
  mobile: string;
  make: string;
  model: string;
  modelYear: number | null;
  plate: string | null;
  vin: string | null;
  branchName: string;
  advisor: string;
  updatedAt: Date;
};

const TERMS = [
  '12-month / 20,000 km warranty on repairs and parts.',
  'We only carry out the lines you approve. Anything new we find during the repair is paused and sent to you for approval first.',
];

// Turns the advisor's entries into the customer-facing document. Nothing is typed twice.
export async function buildBill(db: Pool | PoolClient, jobId: string): Promise<Bill> {
  const job = await db.query<JobRow>(
    `SELECT j.job_number::text AS "jobNumber", j.work_stage AS stage, j.mileage_km AS "mileageKm",
            c.full_name AS "customerName", c.email, c.mobile_number AS mobile,
            v.make, v.model, v.model_year AS "modelYear", v.license_plate AS plate, v.vin,
            b.name AS "branchName", s.display_name AS advisor, j.updated_at AS "updatedAt"
     FROM avc.job_cards j JOIN avc.customers c ON c.id = j.customer_id
     JOIN avc.vehicles v ON v.id = j.vehicle_id JOIN avc.branches b ON b.id = j.branch_id
     JOIN avc.staff_members s ON s.id = j.responsible_staff_id WHERE j.id = $1`,
    [jobId],
  );
  const row = job.rows[0];
  if (!row) throw new AppError(404, 'JOB_NOT_FOUND', 'Job card was not found');
  const quotes = await loadQuotes(db, jobId, { forCustomer: true });
  const revenue = await db.query<{ reversedAt: Date | null }>(
    'SELECT reversed_at AS "reversedAt" FROM avc.revenue_entries WHERE job_card_id = $1',
    [jobId],
  );
  const lines = quotes.flatMap((q) =>
    q.items.map((i) => ({
      position: 0,
      title: i.title,
      detail: i.detail,
      severity: i.severity,
      priceAed: i.priceAed,
      decision: i.decision,
      quoteVersion: q.version,
      kind: q.kind,
      evidenceCount: i.evidence.length,
    })),
  );
  lines.forEach((l, i) => (l.position = i + 1));
  const cents = (n: number) => Math.round(n * 100);
  const sum = (pick: (d: string) => boolean) =>
    lines.filter((l) => pick(l.decision)).reduce((a, l) => a + cents(l.priceAed), 0) / 100;
  const delivered = row.stage === 'delivered';
  const awaitingCustomer = quotes.some((q) => q.status === 'sent');
  const paymentStatus: Bill['paymentStatus'] = revenue.rows[0]
    ? revenue.rows[0].reversedAt
      ? 'reversed'
      : 'received'
    : 'due_on_delivery';

  const instructions = delivered
    ? ['Thank you. Your approved work is complete and the car has been handed back.']
    : awaitingCustomer
      ? [
          'Open your AVC profile and review each line with its photos.',
          'Approve or reject every line. Work starts only on the lines you approve.',
          'Payment is settled on delivery of your car.',
          `Questions? Ask your advisor, ${row.advisor}.`,
        ]
      : ['Your answers are recorded. We will keep you updated at every stage in your AVC profile.'];

  return {
    document: delivered ? 'invoice' : 'estimate',
    number: delivered
      ? `INV-${row.jobNumber}`
      : `Q-${row.jobNumber}-${quotes.at(-1)?.version ?? 0}`,
    issuedAt: quotes.at(-1)?.sentAt ?? row.updatedAt.toISOString(),
    business: { name: 'AVC Garage & Bodyshop', branch: row.branchName },
    customer: { name: row.customerName, email: row.email, mobile: row.mobile },
    vehicle: {
      title: [row.modelYear, row.make, row.model].filter(Boolean).join(' '),
      plate: row.plate,
      vin: row.vin,
      mileageKm: row.mileageKm,
    },
    advisor: row.advisor,
    stage: row.stage,
    lines,
    totals: {
      quotedAed: sum((d) => d !== 'rejected'),
      approvedAed: sum((d) => d === 'approved'),
      declinedAed: sum((d) => d === 'rejected'),
    },
    paymentStatus,
    instructions,
    terms: TERMS,
  };
}
