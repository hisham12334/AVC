import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { inTransaction } from '../db.js';
import { AppError } from '../errors.js';
import { emit } from '../integration/outbox.js';
import { digitsOnly, hashPassword } from '../portal/passwords.js';
import { issueCustomerToken, revokeProfileLinks } from '../portal/tokens.js';

const searchSchema = z.object({ query: z.string().trim().min(2).max(100) });
const directorySchema = z.object({
  query: z.string().trim().max(100).optional().default(''),
  page: z.coerce.number().int().min(1).max(100000).optional().default(1),
});
const customerSchema = z
  .object({
    fullName: z.string().trim().min(1).max(200),
    mobileNumber: z.string().trim().min(6).max(40),
    // The email is the customer's portal username, so it is required.
    email: z.string().trim().toLowerCase().max(200).pipe(z.email()),
  })
  .strict();
const vehicleSchema = z
  .object({
    customerId: z.uuid(),
    vin: z.string().trim().max(30).optional(),
    licensePlate: z.string().trim().max(40).optional(),
    make: z.string().trim().min(1).max(100),
    model: z.string().trim().min(1).max(100),
    modelYear: z.number().int().min(1900).max(2200).optional(),
    color: z.string().trim().max(100).optional(),
  })
  .strict()
  .refine((value) => !!value.vin || !!value.licensePlate, 'VIN or license plate is required');

function mobileSearch(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 6)
    throw new AppError(400, 'INVALID_MOBILE', 'Mobile number needs at least six digits');
  return digits;
}
function plateSearch(value: string): string {
  return value.toUpperCase().replace(/[\s-]/g, '');
}
function like(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

export function registerCrmRoutes(app: FastifyInstance, db: Pool): void {
  app.get(
    '/api/customers',
    { preHandler: app.requirePermission('customers:read') },
    async (request) => {
      const { query } = searchSchema.parse(request.query);
      const digits = query.replace(/\D/g, '');
      const result = await db.query(
        `SELECT id, full_name AS "fullName", mobile_number AS "mobileNumber", email, created_at AS "createdAt"
       FROM avc.customers WHERE full_name ILIKE $1 ESCAPE '\\' OR email ILIKE $1 ESCAPE '\\'
          OR ($2 <> '' AND mobile_search LIKE $3)
       ORDER BY created_at DESC LIMIT 20`,
        [like(query), digits, like(digits)],
      );
      return { customers: result.rows };
    },
  );

  // Admin directory: a complete, paginated list with a count for the current search.
  app.get(
    '/api/customers/directory',
    { preHandler: app.requirePermission('customers:read') },
    async (request, reply) => {
      const { query, page } = directorySchema.parse(request.query);
      const digits = query.replace(/\D/g, '');
      const params = [like(query), digits, like(digits)];
      const where = query
        ? `WHERE full_name ILIKE $1 ESCAPE '\\' OR email ILIKE $1 ESCAPE '\\'
           OR ($2 <> '' AND mobile_search LIKE $3)`
        : '';
      const count = await db.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM avc.customers ${where}`,
        query ? params : [],
      );
      const customers = await db.query(
        `SELECT id, full_name AS "fullName", mobile_number AS "mobileNumber", email,
              created_at AS "createdAt" FROM avc.customers ${where}
       ORDER BY created_at DESC, id DESC LIMIT 25 OFFSET $${query ? 4 : 1}`,
        [...(query ? params : []), (page - 1) * 25],
      );
      reply.header('cache-control', 'no-store');
      return { total: Number(count.rows[0]!.total), page, pageSize: 25, customers: customers.rows };
    },
  );

  app.get(
    '/api/customers/:id',
    { preHandler: app.requirePermission('customers:read') },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const customer = await db.query(
        `SELECT id, full_name AS "fullName", mobile_number AS "mobileNumber", email,
              created_at AS "createdAt" FROM avc.customers WHERE id = $1`,
        [id],
      );
      if (!customer.rowCount)
        throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer was not found');
      const vehicles = await db.query(
        `SELECT id, customer_id AS "customerId", vin, license_plate AS "licensePlate", make,
              model, model_year AS "modelYear", color, created_at AS "createdAt"
       FROM avc.vehicles WHERE customer_id = $1 ORDER BY created_at DESC`,
        [id],
      );
      const jobs = await db.query(
        `SELECT j.id, j.job_number::text AS "jobNumber", j.work_stage AS stage,
              j.created_at AS "createdAt", j.updated_at AS "updatedAt",
              j.mileage_km AS "mileageKm", j.intake_condition AS "intakeCondition",
              v.id AS "vehicleId", v.make, v.model, v.license_plate AS "licensePlate"
       FROM avc.job_cards j JOIN avc.vehicles v ON v.id = j.vehicle_id
       WHERE j.customer_id = $1 ORDER BY j.created_at DESC`,
        [id],
      );
      reply.header('cache-control', 'no-store');
      return { customer: customer.rows[0], vehicles: vehicles.rows, jobs: jobs.rows };
    },
  );

  app.post(
    '/api/customers',
    { preHandler: app.requirePermission('customers:create') },
    async (request, reply) => {
      const input = customerSchema.parse(request.body);
      const normalized = mobileSearch(input.mobileNumber);
      const customer = await inTransaction(db, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `customer:${normalized}:${input.fullName.toLowerCase()}`,
        ]);
        const existing = await client.query(
          'SELECT id FROM avc.customers WHERE mobile_search = $1 AND lower(full_name) = lower($2) LIMIT 1',
          [normalized, input.fullName],
        );
        if (existing.rowCount)
          throw new AppError(
            409,
            'POSSIBLE_DUPLICATE_CUSTOMER',
            'A matching customer exists; search before creating another',
          );
        const sameEmail = await client.query(
          'SELECT 1 FROM avc.customers WHERE lower(email) = $1',
          [input.email],
        );
        if (sameEmail.rowCount)
          throw new AppError(
            409,
            'POSSIBLE_DUPLICATE_CUSTOMER',
            'A customer with this email already exists; search before creating another',
          );
        const created = await client.query(
          `INSERT INTO avc.customers(full_name, mobile_number, mobile_search, email, created_by_staff_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, full_name AS "fullName", mobile_number AS "mobileNumber", email, created_at AS "createdAt"`,
          [input.fullName, input.mobileNumber, normalized, input.email, request.staff!.id],
        );
        const row = created.rows[0];
        // Client decision: the starting password is the mobile number. Only its hash is stored.
        await client.query(
          'INSERT INTO avc.customer_accounts(customer_id, password_hash) VALUES ($1, $2)',
          [row.id, await hashPassword(digitsOnly(input.mobileNumber))],
        );
        const profileLink = await issueCustomerToken(
          client,
          row.id,
          'profile_link',
          request.staff!.id,
        );
        await emit(client, {
          branchId: null,
          type: 'customer.created',
          aggregateType: 'customer',
          aggregateId: row.id,
          payload: {
            customerId: row.id,
            fullName: row.fullName,
            mobileNumber: row.mobileNumber,
            email: row.email,
          },
        });
        return { row, profileLink };
      });
      // The profile link (QR) is shown once; staff can re-issue it later.
      return reply.status(201).send({
        customer: customer.row,
        profileLink: {
          token: customer.profileLink.token,
          path: customer.profileLink.path,
          expiresAt: customer.profileLink.expiresAt,
        },
      });
    },
  );

  // Replace the customer's QR/link (for example if it was lost). The previous one stops working.
  app.post(
    '/api/customers/:id/profile-link',
    { preHandler: app.requirePermission('customer_links:issue') },
    async (request, reply) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const link = await inTransaction(db, async (client) => {
        const found = await client.query(
          'SELECT 1 FROM avc.customer_accounts WHERE customer_id = $1',
          [id],
        );
        if (!found.rowCount)
          throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer has no portal profile');
        await revokeProfileLinks(client, id);
        return issueCustomerToken(client, id, 'profile_link', request.staff!.id);
      });
      return reply
        .status(201)
        .send({ profileLink: { token: link.token, path: link.path, expiresAt: link.expiresAt } });
    },
  );

  app.get(
    '/api/customers/:id/vehicles',
    { preHandler: app.requirePermission('vehicles:read') },
    async (request) => {
      const { id } = z.object({ id: z.uuid() }).parse(request.params);
      const result = await db.query(
        `SELECT id, customer_id AS "customerId", vin, license_plate AS "licensePlate", make, model,
                model_year AS "modelYear", color FROM avc.vehicles WHERE customer_id = $1 ORDER BY created_at`,
        [id],
      );
      return { vehicles: result.rows };
    },
  );

  app.get(
    '/api/vehicles',
    { preHandler: app.requirePermission('vehicles:read') },
    async (request) => {
      const { query } = searchSchema.parse(request.query);
      const result = await db.query(
        `SELECT id, customer_id AS "customerId", vin, license_plate AS "licensePlate", make, model,
              model_year AS "modelYear", color, created_at AS "createdAt"
       FROM avc.vehicles WHERE vin ILIKE $1 ESCAPE '\\' OR license_plate ILIKE $1 ESCAPE '\\'
          OR make ILIKE $1 ESCAPE '\\' OR model ILIKE $1 ESCAPE '\\'
       ORDER BY created_at DESC LIMIT 20`,
        [like(query)],
      );
      return { vehicles: result.rows };
    },
  );

  app.post(
    '/api/vehicles',
    { preHandler: app.requirePermission('vehicles:create') },
    async (request, reply) => {
      const input = vehicleSchema.parse(request.body);
      const vin = input.vin?.toUpperCase() || null;
      const plate = input.licensePlate || null;
      const plateKey = plate ? plateSearch(plate) : null;
      const vehicle = await inTransaction(db, async (client) => {
        const owner = await client.query('SELECT id FROM avc.customers WHERE id = $1', [
          input.customerId,
        ]);
        if (!owner.rowCount)
          throw new AppError(422, 'CUSTOMER_NOT_FOUND', 'Customer does not exist');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `vehicle:${vin ?? `${input.customerId}:${plateKey}`}`,
        ]);
        const existing = await client.query(
          `SELECT id FROM avc.vehicles WHERE ($1::text IS NOT NULL AND vin = $1)
            OR ($2::text IS NOT NULL AND customer_id = $3 AND plate_search = $2) LIMIT 1`,
          [vin, plateKey, input.customerId],
        );
        if (existing.rowCount)
          throw new AppError(
            409,
            'POSSIBLE_DUPLICATE_VEHICLE',
            'A matching vehicle exists; search before creating another',
          );
        const created = await client.query(
          `INSERT INTO avc.vehicles(customer_id, vin, license_plate, plate_search, make, model, model_year, color, created_by_staff_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, customer_id AS "customerId", vin, license_plate AS "licensePlate", make, model,
                   model_year AS "modelYear", color, created_at AS "createdAt"`,
          [
            input.customerId,
            vin,
            plate,
            plateKey,
            input.make,
            input.model,
            input.modelYear ?? null,
            input.color ?? null,
            request.staff!.id,
          ],
        );
        const row = created.rows[0];
        await emit(client, {
          branchId: null,
          type: 'vehicle.created',
          aggregateType: 'vehicle',
          aggregateId: row.id,
          payload: {
            vehicleId: row.id,
            customerId: row.customerId,
            vin: row.vin,
            licensePlate: row.licensePlate,
            make: row.make,
            model: row.model,
            modelYear: row.modelYear,
            color: row.color,
          },
        });
        return row;
      });
      return reply.status(201).send({ vehicle });
    },
  );
}
