import { getPool, closePool } from './models/database';
import { logger } from './config/logger';

/**
 * Seed the database with realistic test data that exercises the lifecycle scenarios.
 */
async function seed() {
  const pool = getPool();

  // Clear existing data
  await pool.query('DELETE FROM sync_events');
  await pool.query('DELETE FROM sync_runs');
  await pool.query('DELETE FROM phone_number_audit');
  await pool.query('DELETE FROM technician_status_changes');
  await pool.query('DELETE FROM jobs');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM companies');

  // ── Companies ──
  const { rows: [company1] } = await pool.query(`
    INSERT INTO companies (id, name, pos_provider, pos_tenant_id)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'Apex Plumbing & HVAC', 'servicetitan', 'tenant-100')
    RETURNING *
  `);

  const { rows: [company2] } = await pool.query(`
    INSERT INTO companies (id, name, pos_provider, pos_tenant_id)
    VALUES ('a0000000-0000-0000-0000-000000000002', 'Elite Electrical Services', 'servicetitan', 'tenant-200')
    RETURNING *
  `);

  const { rows: [company3] } = await pool.query(`
    INSERT INTO companies (id, name, pos_provider, pos_tenant_id)
    VALUES ('a0000000-0000-0000-0000-000000000003', 'QuickFix Home Services', 'none', NULL)
    RETURNING *
  `);

  // ── Technicians for Apex Plumbing ──
  // Active tech - will remain active in ServiceTitan
  await pool.query(`
    INSERT INTO users (id, first_name, last_name, cell_phone, email, role, company_id, pos_technician_id, is_active, stripe_account_id)
    VALUES ('b0000000-0000-0000-0000-000000000001', 'Jane', 'Doe', '+15551234567', 'jane@apex.com', 'technician', $1, '101', true, 'acct_jane123')
  `, [company1.id]);

  // Active tech - will be deactivated in next sync (simulates departure)
  await pool.query(`
    INSERT INTO users (id, first_name, last_name, cell_phone, email, role, company_id, pos_technician_id, is_active, stripe_account_id)
    VALUES ('b0000000-0000-0000-0000-000000000002', 'Bob', 'Smith', '+15559876543', 'bob@apex.com', 'technician', $1, '102', true, 'acct_bob456')
  `, [company1.id]);

  // Active tech - phone will be reassigned to new hire
  await pool.query(`
    INSERT INTO users (id, first_name, last_name, cell_phone, email, role, company_id, pos_technician_id, is_active, stripe_account_id)
    VALUES ('b0000000-0000-0000-0000-000000000003', 'Carlos', 'Rivera', '+15555550001', 'carlos@apex.com', 'technician', $1, '103', true, 'acct_carlos789')
  `, [company1.id]);

  // Admin for Apex
  await pool.query(`
    INSERT INTO users (id, first_name, last_name, cell_phone, email, role, company_id, is_active)
    VALUES ('b0000000-0000-0000-0000-000000000010', 'Sarah', 'Manager', '+15550000001', 'sarah@apex.com', 'admin', $1, true)
  `, [company1.id]);

  // ── Technicians for Elite Electrical ──
  await pool.query(`
    INSERT INTO users (id, first_name, last_name, cell_phone, email, role, company_id, pos_technician_id, is_active, stripe_account_id)
    VALUES ('b0000000-0000-0000-0000-000000000004', 'Diana', 'Chen', '+15552223333', 'diana@elite.com', 'technician', $1, '201', true, 'acct_diana321')
  `, [company2.id]);

  await pool.query(`
    INSERT INTO users (id, first_name, last_name, cell_phone, email, role, company_id, pos_technician_id, is_active, stripe_account_id)
    VALUES ('b0000000-0000-0000-0000-000000000005', 'Erik', 'Johnson', '+15553334444', 'erik@elite.com', 'technician', $1, '202', true, NULL)
  `, [company2.id]);

  // ── Some jobs ──
  await pool.query(`
    INSERT INTO jobs (created_by_user_id, created_by_company_id, homeowner_phone, summary, status)
    VALUES ('b0000000-0000-0000-0000-000000000001', $1, '+15559990001', 'Leaky kitchen faucet needs repair', 'completed'),
           ('b0000000-0000-0000-0000-000000000002', $1, '+15559990002', 'Water heater installation', 'routed'),
           ('b0000000-0000-0000-0000-000000000004', $2, '+15559990003', 'Panel upgrade 100A to 200A', 'pending')
  `, [company1.id, company2.id]);

  logger.info('Seed data inserted successfully');
  logger.info({
    companies: 3,
    technicians: 5,
    admins: 1,
    jobs: 3,
  }, 'Seed summary');

  await closePool();
}

seed().catch((err) => {
  logger.error({ err }, 'Seeding failed');
  process.exit(1);
});
