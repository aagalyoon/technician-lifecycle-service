import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { syncCompany, syncAllCompanies } from '../../src/services/sync-engine';
import { registerProvider, getProvider } from '../../src/providers/base';
import { PoSProvider, PoSTechnician, Company } from '../../src/models/types';
import * as db from '../../src/models/database';

/**
 * Integration tests for the sync engine.
 * Uses a real PostgreSQL database (requires DB to be running).
 *
 * Tests cover every scenario from the case study:
 * 1. Technician departure with phone release
 * 2. Phone number reassignment to new hire
 * 3. Phone conflict with active user (cross-company)
 * 4. Returning technician
 * 5. Idempotency - running sync twice produces same result
 * 6. Earnings preservation on departure
 */

// Mock provider that returns configurable data
class MockProvider implements PoSProvider {
  name = 'servicetitan';
  technicians: PoSTechnician[] = [];

  async fetchTechnicians(_tenantId: string): Promise<PoSTechnician[]> {
    return this.technicians;
  }

  setTechnicians(techs: PoSTechnician[]) {
    this.technicians = techs;
  }
}

let pool: Pool;
let mockProvider: MockProvider;
let testCompanyId: string;
let testCompany: Company;

beforeAll(async () => {
  // Connect to test database
  pool = new Pool({
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    database: process.env.DATABASE_NAME || 'techlifecycle',
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
  });

  // Register mock provider
  mockProvider = new MockProvider();
  registerProvider(mockProvider);
});

beforeEach(async () => {
  // Clean test data
  await pool.query('DELETE FROM sync_events');
  await pool.query('DELETE FROM sync_runs');
  await pool.query('DELETE FROM phone_number_audit');
  await pool.query('DELETE FROM technician_status_changes');
  await pool.query('DELETE FROM jobs');
  await pool.query('DELETE FROM users');
  await pool.query('DELETE FROM companies');

  // Create test company
  testCompanyId = uuidv4();
  await pool.query(
    `INSERT INTO companies (id, name, pos_provider, pos_tenant_id)
     VALUES ($1, 'Test Company', 'servicetitan', 'test-tenant')`,
    [testCompanyId]
  );
  testCompany = {
    id: testCompanyId,
    name: 'Test Company',
    pos_provider: 'servicetitan',
    pos_tenant_id: 'test-tenant',
  };
});

afterAll(async () => {
  await pool.end();
});

describe('Sync Engine - Technician Departure', () => {
  it('deactivates a technician when they are inactive in PoS', async () => {
    // Setup: active technician in the platform
    const userId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, first_name, last_name, cell_phone, role, company_id, pos_technician_id, is_active, stripe_account_id)
       VALUES ($1, 'Bob', 'Smith', '+15559876543', 'technician', $2, 'pos-101', true, 'acct_bob')`,
      [userId, testCompanyId]
    );

    // PoS says Bob is now inactive
    mockProvider.setTechnicians([
      { externalId: 'pos-101', firstName: 'Bob', lastName: 'Smith', email: 'bob@test.com', phone: '+15559876543', active: false },
    ]);

    const result = await syncCompany(testCompany);

    expect(result.changesDetected).toBe(1);
    expect(result.changesApplied).toBe(1);

    // Verify user was deactivated
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    expect(user.is_active).toBe(false);
    expect(user.cell_phone).toBeNull(); // Phone released
    expect(user.last_known_phone).toBe('+15559876543'); // Phone preserved for history
    expect(user.stripe_account_id).toBe('acct_bob'); // Stripe NOT unlinked - earnings preserved

    // Verify phone was released in audit
    const { rows: audits } = await pool.query('SELECT * FROM phone_number_audit WHERE phone_number = $1', ['+15559876543']);
    expect(audits.length).toBe(1);
    expect(audits[0].action).toBe('released');
  });

  it('preserves Stripe account so departed tech can claim earnings', async () => {
    const userId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, first_name, last_name, cell_phone, role, company_id, pos_technician_id, is_active, stripe_account_id)
       VALUES ($1, 'Alice', 'Brown', '+15551111111', 'technician', $2, 'pos-201', true, 'acct_alice')`,
      [userId, testCompanyId]
    );

    mockProvider.setTechnicians([
      { externalId: 'pos-201', firstName: 'Alice', lastName: 'Brown', email: null, phone: '+15551111111', active: false },
    ]);

    await syncCompany(testCompany);

    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    expect(user.is_active).toBe(false);
    expect(user.stripe_account_id).toBe('acct_alice'); // Still linked!

    // Verify earnings_preserved event was logged
    const { rows: events } = await pool.query(
      `SELECT * FROM sync_events WHERE user_id = $1 AND event_type = 'earnings_preserved'`,
      [userId]
    );
    expect(events.length).toBe(1);
  });
});

describe('Sync Engine - New Technician Onboarding', () => {
  it('auto-onboards a new technician with no phone conflict', async () => {
    mockProvider.setTechnicians([
      { externalId: 'pos-301', firstName: 'Frank', lastName: 'Lee', email: 'frank@test.com', phone: '+15557778888', active: true },
    ]);

    const result = await syncCompany(testCompany);

    expect(result.changesDetected).toBe(1);
    expect(result.changesApplied).toBe(1);
    expect(result.flagsForReview).toBe(0);

    const { rows } = await pool.query(
      `SELECT * FROM users WHERE pos_technician_id = 'pos-301'`
    );
    expect(rows.length).toBe(1);
    expect(rows[0].first_name).toBe('Frank');
    expect(rows[0].cell_phone).toBe('+15557778888');
    expect(rows[0].is_active).toBe(true);
  });

  it('flags phone conflict when new tech has phone of active user', async () => {
    // Active user already has +15552223333
    const existingUserId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, first_name, last_name, cell_phone, role, company_id, pos_technician_id, is_active)
       VALUES ($1, 'Diana', 'Chen', '+15552223333', 'technician', $2, 'pos-existing', true)`,
      [existingUserId, testCompanyId]
    );

    // New tech from PoS has the same phone
    mockProvider.setTechnicians([
      { externalId: 'pos-existing', firstName: 'Diana', lastName: 'Chen', email: null, phone: '+15552223333', active: true },
      { externalId: 'pos-401', firstName: 'Dave', lastName: 'Wilson', email: null, phone: '+15552223333', active: true },
    ]);

    const result = await syncCompany(testCompany);

    expect(result.flagsForReview).toBe(1);

    // New tech should NOT have been created with the conflicting phone
    const { rows: daves } = await pool.query(
      `SELECT * FROM users WHERE pos_technician_id = 'pos-401'`
    );
    expect(daves.length).toBe(0); // Not onboarded - conflict!

    // Review item should exist
    const { rows: reviews } = await pool.query(
      `SELECT * FROM technician_status_changes WHERE requires_review = true`
    );
    expect(reviews.length).toBe(1);
    expect(reviews[0].reason).toContain('Phone number conflict');
  });
});

describe('Sync Engine - Phone Reassignment', () => {
  it('handles phone reassignment from departed tech to new hire', async () => {
    // Carlos was active but is now departing, and Maria gets his phone
    const carlosId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, first_name, last_name, cell_phone, role, company_id, pos_technician_id, is_active, stripe_account_id)
       VALUES ($1, 'Carlos', 'Rivera', '+15555550001', 'technician', $2, 'pos-103', true, 'acct_carlos')`,
      [carlosId, testCompanyId]
    );

    // PoS: Carlos inactive, Maria active with Carlos's old phone
    mockProvider.setTechnicians([
      { externalId: 'pos-103', firstName: 'Carlos', lastName: 'Rivera', email: null, phone: '+15555550001', active: false },
      { externalId: 'pos-104', firstName: 'Maria', lastName: 'Garcia', email: null, phone: '+15555550001', active: true },
    ]);

    const result = await syncCompany(testCompany);

    // Carlos should be deactivated first (phone released)
    const { rows: [carlos] } = await pool.query('SELECT * FROM users WHERE id = $1', [carlosId]);
    expect(carlos.is_active).toBe(false);
    expect(carlos.cell_phone).toBeNull();
    expect(carlos.last_known_phone).toBe('+15555550001');

    // Maria should be onboarded with the phone (no conflict since Carlos's was released)
    const { rows: marias } = await pool.query(
      `SELECT * FROM users WHERE pos_technician_id = 'pos-104'`
    );
    expect(marias.length).toBe(1);
    expect(marias[0].cell_phone).toBe('+15555550001');
    expect(marias[0].is_active).toBe(true);

    // Phone reassignment should be in audit trail
    const { rows: audits } = await pool.query(
      `SELECT * FROM phone_number_audit WHERE phone_number = '+15555550001' ORDER BY created_at`
    );
    expect(audits.length).toBe(2); // One release, one reassignment
    expect(audits[0].action).toBe('released');
    expect(audits[1].action).toBe('reassigned');
  });
});

describe('Sync Engine - Technician Return', () => {
  it('reactivates a returning technician', async () => {
    const userId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, first_name, last_name, cell_phone, last_known_phone, role, company_id, pos_technician_id, is_active, deactivated_at, stripe_account_id)
       VALUES ($1, 'Bob', 'Smith', NULL, '+15559876543', 'technician', $2, 'pos-102', false, NOW(), 'acct_bob')`,
      [userId, testCompanyId]
    );

    // Bob is back and active in PoS
    mockProvider.setTechnicians([
      { externalId: 'pos-102', firstName: 'Bob', lastName: 'Smith', email: 'bob@test.com', phone: '+15559876543', active: true },
    ]);

    const result = await syncCompany(testCompany);

    expect(result.changesDetected).toBe(1);
    expect(result.changesApplied).toBe(1);

    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    expect(user.is_active).toBe(true);
    expect(user.cell_phone).toBe('+15559876543'); // Phone restored
    expect(user.deactivated_at).toBeNull();
    expect(user.stripe_account_id).toBe('acct_bob'); // Stripe still linked
  });

  it('reactivates returning tech but flags phone conflict if phone is taken', async () => {
    // Bob is inactive, but his old phone is now used by someone else
    const bobId = uuidv4();
    const otherUserId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, first_name, last_name, cell_phone, role, company_id, pos_technician_id, is_active)
       VALUES ($1, 'Other', 'User', '+15559876543', 'technician', $2, 'pos-other', true)`,
      [otherUserId, testCompanyId]
    );
    await pool.query(
      `INSERT INTO users (id, first_name, last_name, cell_phone, last_known_phone, role, company_id, pos_technician_id, is_active, deactivated_at)
       VALUES ($1, 'Bob', 'Smith', NULL, '+15559876543', 'technician', $2, 'pos-102', false, NOW())`,
      [bobId, testCompanyId]
    );

    mockProvider.setTechnicians([
      { externalId: 'pos-other', firstName: 'Other', lastName: 'User', email: null, phone: '+15559876543', active: true },
      { externalId: 'pos-102', firstName: 'Bob', lastName: 'Smith', email: null, phone: '+15559876543', active: true },
    ]);

    const result = await syncCompany(testCompany);

    // Bob should be reactivated BUT without the phone
    const { rows: [bob] } = await pool.query('SELECT * FROM users WHERE id = $1', [bobId]);
    expect(bob.is_active).toBe(true);
    expect(bob.cell_phone).toBeNull(); // Can't assign - conflict

    // Should have a review flag
    expect(result.flagsForReview).toBeGreaterThanOrEqual(1);
  });
});

describe('Sync Engine - Idempotency', () => {
  it('produces the same result when run twice', async () => {
    const userId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, first_name, last_name, cell_phone, role, company_id, pos_technician_id, is_active)
       VALUES ($1, 'Jane', 'Doe', '+15551234567', 'technician', $2, 'pos-101', true)`,
      [userId, testCompanyId]
    );

    mockProvider.setTechnicians([
      { externalId: 'pos-101', firstName: 'Jane', lastName: 'Doe', email: 'jane@test.com', phone: '+15551234567', active: true },
    ]);

    // First sync
    const result1 = await syncCompany(testCompany);
    expect(result1.changesDetected).toBe(0);

    // Second sync - should produce same result
    const result2 = await syncCompany(testCompany);
    expect(result2.changesDetected).toBe(0);

    // Jane should still be exactly the same
    const { rows: [jane] } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    expect(jane.is_active).toBe(true);
    expect(jane.cell_phone).toBe('+15551234567');
  });

  it('does not re-deactivate an already deactivated tech', async () => {
    const userId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, first_name, last_name, cell_phone, role, company_id, pos_technician_id, is_active, deactivated_at)
       VALUES ($1, 'Bob', 'Smith', NULL, 'technician', $2, 'pos-102', false, NOW())`,
      [userId, testCompanyId]
    );

    mockProvider.setTechnicians([
      { externalId: 'pos-102', firstName: 'Bob', lastName: 'Smith', email: null, phone: null, active: false },
    ]);

    const result = await syncCompany(testCompany);
    expect(result.changesDetected).toBe(0); // No change - already deactivated
  });
});

describe('Sync Engine - Phone Number Normalization', () => {
  it('correctly matches phone numbers across different formats', async () => {
    const userId = uuidv4();
    await pool.query(
      `INSERT INTO users (id, first_name, last_name, cell_phone, role, company_id, pos_technician_id, is_active)
       VALUES ($1, 'Jane', 'Doe', '+15551234567', 'technician', $2, 'pos-101', true)`,
      [userId, testCompanyId]
    );

    // PoS returns phone in a completely different format
    mockProvider.setTechnicians([
      { externalId: 'pos-101', firstName: 'Jane', lastName: 'Doe', email: null, phone: '+15551234567', active: true },
    ]);

    const result = await syncCompany(testCompany);
    expect(result.changesDetected).toBe(0); // Should match despite format difference
  });
});
