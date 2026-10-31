import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { STAGES } from '../jobs/lifecycle.js';

const querySchema = z.object({ branchId: z.uuid().optional() });

type Counts = {
  stage: string;
  cars: string;
};

export function registerDashboardRoutes(app: FastifyInstance, db: Pool): void {
  // Operational numbers for the admin. `approvedValue*` is what customers have approved (booked work),
  // not invoiced revenue; invoiced revenue arrives with the Zoho integration.
  app.get(
    '/api/dashboard/summary',
    { preHandler: app.requirePermission('dashboard:read') },
    async (request) => {
      const { branchId: requested } = querySchema.parse(request.query);
      const staff = request.staff!;
      if (staff.branchId && requested && requested !== staff.branchId)
        throw new AppError(
          403,
          'BRANCH_FORBIDDEN',
          'This staff member works at a different branch',
        );
      const branchId = staff.branchId ?? requested ?? null;

      const scope = await db.query<{ capacity: string; branches: string }>(
        `SELECT COALESCE(SUM(bay_capacity), 0)::text AS capacity, COUNT(*)::text AS branches
         FROM avc.branches WHERE active AND ($1::uuid IS NULL OR id = $1)`,
        [branchId],
      );
      if (branchId && scope.rows[0]!.branches === '0')
        throw new AppError(404, 'BRANCH_NOT_FOUND', 'Branch does not exist');

      const active = await db.query<
        Counts & { fresh: string; standard: string; delayed: string; critical: string }
      >(
        `SELECT work_stage AS stage, COUNT(*)::text AS cars,
                COUNT(*) FILTER (WHERE age < 4)::text AS fresh,
                COUNT(*) FILTER (WHERE age BETWEEN 4 AND 7)::text AS standard,
                COUNT(*) FILTER (WHERE age BETWEEN 8 AND 14)::text AS delayed,
                COUNT(*) FILTER (WHERE age >= 15)::text AS critical
         FROM (SELECT work_stage, floor(extract(epoch FROM now() - created_at) / 86400) AS age
               FROM avc.job_cards WHERE work_stage <> 'delivered' AND ($1::uuid IS NULL OR branch_id = $1)) a
         GROUP BY work_stage`,
        [branchId],
      );
      const waiting = await db.query<{ initial: string; addendum: string }>(
        `SELECT COUNT(*) FILTER (WHERE q.kind = 'initial')::text AS initial,
                COUNT(*) FILTER (WHERE q.kind = 'addendum')::text AS addendum
         FROM avc.quotes q JOIN avc.job_cards j ON j.id = q.job_card_id
         WHERE q.status = 'sent' AND ($1::uuid IS NULL OR j.branch_id = $1)`,
        [branchId],
      );
      const month = await db.query<{
        delivered: string;
        approvedMtd: string;
        approvedToday: string;
        revenueMtd: string;
        revenueToday: string;
      }>(
        `WITH bounds AS (
           SELECT date_trunc('month', now() AT TIME ZONE 'Asia/Dubai') AT TIME ZONE 'Asia/Dubai' AS month_start,
                  date_trunc('day', now() AT TIME ZONE 'Asia/Dubai') AT TIME ZONE 'Asia/Dubai' AS day_start
         )
         SELECT
           (SELECT COUNT(*) FROM avc.job_events e JOIN avc.job_cards j ON j.id = e.job_card_id, bounds
             WHERE e.to_status = 'delivered' AND e.occurred_at >= bounds.month_start
               AND ($1::uuid IS NULL OR j.branch_id = $1))::text AS delivered,
           (SELECT COALESCE(SUM(i.price_aed), 0) FROM avc.quote_items i
              JOIN avc.quotes q ON q.id = i.quote_id JOIN avc.job_cards j ON j.id = q.job_card_id, bounds
             WHERE i.decision = 'approved' AND i.decided_at >= bounds.month_start
               AND ($1::uuid IS NULL OR j.branch_id = $1))::text AS "approvedMtd",
           (SELECT COALESCE(SUM(i.price_aed), 0) FROM avc.quote_items i
              JOIN avc.quotes q ON q.id = i.quote_id JOIN avc.job_cards j ON j.id = q.job_card_id, bounds
             WHERE i.decision = 'approved' AND i.decided_at >= bounds.day_start
               AND ($1::uuid IS NULL OR j.branch_id = $1))::text AS "approvedToday",
           (SELECT COALESCE(SUM(r.amount_aed), 0) FROM avc.revenue_entries r, bounds
             WHERE r.reversed_at IS NULL AND r.recognised_at >= bounds.month_start
               AND ($1::uuid IS NULL OR r.branch_id = $1))::text AS "revenueMtd",
           (SELECT COALESCE(SUM(r.amount_aed), 0) FROM avc.revenue_entries r, bounds
             WHERE r.reversed_at IS NULL AND r.recognised_at >= bounds.day_start
               AND ($1::uuid IS NULL OR r.branch_id = $1))::text AS "revenueToday"`,
        [branchId],
      );

      const pricing = await db.query<{ waiting: string; addendum: string }>(
        `SELECT COUNT(*)::text AS waiting, COUNT(*) FILTER (WHERE b.kind = 'addendum')::text AS addendum
         FROM avc.finding_batches b JOIN avc.job_cards j ON j.id = b.job_card_id
         WHERE b.status = 'awaiting_pricing' AND ($1::uuid IS NULL OR j.branch_id = $1)`,
        [branchId],
      );
      const byStage = Object.fromEntries(
        STAGES.filter((s) => s !== 'delivered').map((s) => [s, 0]),
      );
      const aging = { fresh: 0, standard: 0, delayed: 0, critical: 0 };
      let activeCars = 0;
      for (const row of active.rows) {
        byStage[row.stage] = Number(row.cars);
        activeCars += Number(row.cars);
        aging.fresh += Number(row.fresh);
        aging.standard += Number(row.standard);
        aging.delayed += Number(row.delayed);
        aging.critical += Number(row.critical);
      }
      const capacity = Number(scope.rows[0]!.capacity);
      return {
        asOf: new Date().toISOString(),
        branchId,
        capacity,
        activeCars,
        capacityUsedPercent: capacity ? Math.round((activeCars / capacity) * 1000) / 10 : 0,
        byStage,
        aging,
        awaitingApproval: Number(waiting.rows[0]!.initial),
        // Work is paused from the moment the technician raises a finding until the customer decides.
        pausedForFinding: Number(waiting.rows[0]!.addendum) + Number(pricing.rows[0]!.addendum),
        awaitingPricing: Number(pricing.rows[0]!.waiting),
        deliveredMtd: Number(month.rows[0]!.delivered),
        approvedValueMtdAed: Number(month.rows[0]!.approvedMtd),
        approvedValueTodayAed: Number(month.rows[0]!.approvedToday),
        // Delivered cars count as received (client rule); reversed entries are excluded.
        revenueMtdAed: Number(month.rows[0]!.revenueMtd),
        revenueTodayAed: Number(month.rows[0]!.revenueToday),
      };
    },
  );
}
