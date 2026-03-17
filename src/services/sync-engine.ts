import { v4 as uuidv4 } from 'uuid';
import { PoolClient } from 'pg';
import { logger } from '../config/logger';
import { withTransaction, query } from '../models/database';
import { Company, PoSTechnician, User, SyncEventType } from '../models/types';
import { getProvider } from '../providers/base';
import { normalizePhone } from '../utils/phone';

interface SyncResult {
  syncRunId: string;
  companyId: string;
  companyName: string;
  techniciansProcessed: number;
  changesDetected: number;
  changesApplied: number;
  flagsForReview: number;
  events: Array<{ type: SyncEventType; detail: string }>;
}

/**
 * Core sync engine. For each company with a PoS integration:
 * 1. Fetch current technician roster from the PoS
 * 2. Compare against our local state
 * 3. Handle departures, new hires, phone conflicts, and returns
 * 4. Log everything for auditability
 *
 * Design principles:
 * - Idempotent: running twice produces the same result
 * - Atomic: each company sync is wrapped in a transaction
 * - Safe: phone conflicts and ambiguous situations are flagged for human review
 *   rather than auto-resolved, because the stakes (financial accounts, identity) are high
 */
export async function syncCompany(company: Company): Promise<SyncResult> {
  const syncRunId = uuidv4();
  const events: Array<{ type: SyncEventType; detail: string }> = [];
  let changesDetected = 0;
  let changesApplied = 0;
  let flagsForReview = 0;

  const provider = getProvider(company.pos_provider);
  if (!provider) {
    logger.warn({ company: company.name, provider: company.pos_provider }, 'No provider registered');
    return {
      syncRunId, companyId: company.id, companyName: company.name,
      techniciansProcessed: 0, changesDetected: 0, changesApplied: 0, flagsForReview: 0, events,
    };
  }

  if (!company.pos_tenant_id) {
    logger.warn({ company: company.name }, 'Company has no PoS tenant ID');
    return {
      syncRunId, companyId: company.id, companyName: company.name,
      techniciansProcessed: 0, changesDetected: 0, changesApplied: 0, flagsForReview: 0, events,
    };
  }

  // Record sync run start
  await query(
    `INSERT INTO sync_runs (id, company_id, status) VALUES ($1, $2, 'running')`,
    [syncRunId, company.id]
  );

  try {
    // 1. Fetch current roster from PoS (batch operation)
    const posTechnicians = await provider.fetchTechnicians(company.pos_tenant_id);

    // 2. Fetch our local technicians for this company
    const { rows: localTechs } = await query(
      `SELECT * FROM users WHERE company_id = $1 AND role = 'technician'`,
      [company.id]
    );

    // Build lookup maps
    const localByPosId = new Map<string, User>();
    const localByPhone = new Map<string, User>();
    for (const tech of localTechs) {
      if (tech.pos_technician_id) {
        localByPosId.set(tech.pos_technician_id, tech);
      }
      if (tech.cell_phone) {
        const normalized = normalizePhone(tech.cell_phone);
        if (normalized) {
          localByPhone.set(normalized, tech);
        }
      }
    }

    // 3. Process each PoS technician inside a transaction
    await withTransaction(async (client) => {
      for (const posTech of posTechnicians) {
        const localByPos = localByPosId.get(posTech.externalId);

        if (localByPos) {
          // ── Known technician (matched by PoS ID) ──
          if (posTech.active && !localByPos.is_active) {
            // Reactivation - a previously departed tech has returned
            const result = await handleTechnicianReturn(client, syncRunId, company, localByPos, posTech);
            changesDetected++;
            changesApplied += result.applied;
            flagsForReview += result.flagged;
            events.push(...result.events);
          } else if (!posTech.active && localByPos.is_active) {
            // Departure detected
            const result = await handleTechnicianDeparture(client, syncRunId, company, localByPos, posTech);
            changesDetected++;
            changesApplied += result.applied;
            flagsForReview += result.flagged;
            events.push(...result.events);
          } else {
            // Still active/inactive - update metadata if changed
            await updateTechnicianMetadata(client, localByPos, posTech);
          }
        } else if (posTech.active) {
          // ── New technician in PoS not yet in the platform ──
          const result = await handleNewTechnician(client, syncRunId, company, posTech, localByPhone);
          changesDetected++;
          changesApplied += result.applied;
          flagsForReview += result.flagged;
          events.push(...result.events);
        }
        // Inactive techs not in our system are ignored - nothing to do
      }

      // 4. Check for technicians in our system that are no longer in the PoS roster at all
      //    This handles cases where a tech was completely removed (not just deactivated)
      const posIdSet = new Set(posTechnicians.map((t) => t.externalId));
      for (const localTech of localTechs) {
        if (
          localTech.is_active &&
          localTech.pos_technician_id &&
          !posIdSet.has(localTech.pos_technician_id)
        ) {
          // Tech exists locally but is completely missing from PoS - flag for review
          // We don't auto-deactivate because the tech might have been miscategorized
          // or the API might have returned a partial page

          // Idempotency: skip if already flagged
          const { rows: existing } = await client.query(
            `SELECT id FROM technician_status_changes
             WHERE user_id = $1 AND requires_review = true AND reviewed_at IS NULL
               AND reason LIKE '%missing from PoS roster%'`,
            [localTech.id]
          );

          if (existing.length === 0) {
            changesDetected++;
            flagsForReview++;
            await recordStatusChange(client, {
              userId: localTech.id,
              companyId: company.id,
              previousStatus: 'active',
              newStatus: 'active', // Don't change status - just flag
              reason: `Technician ${localTech.first_name} ${localTech.last_name} (PoS ID: ${localTech.pos_technician_id}) is missing from PoS roster. May have been removed or API returned incomplete data.`,
              posTechnicianId: localTech.pos_technician_id,
              phoneNumber: localTech.cell_phone,
              requiresReview: true,
            });
            await recordSyncEvent(client, syncRunId, company.id, 'technician_deactivated', localTech.id, localTech.pos_technician_id, {
              action: 'flagged_for_review',
              reason: 'missing_from_pos_roster',
            });
            events.push({ type: 'technician_deactivated', detail: `${localTech.first_name} ${localTech.last_name} missing from PoS - flagged for review` });
          }
        }
      }

      // Update last_synced_at for all processed techs
      const allPosIds = posTechnicians.map((t) => t.externalId);
      if (allPosIds.length > 0) {
        await client.query(
          `UPDATE users SET last_synced_at = NOW() WHERE company_id = $1 AND pos_technician_id = ANY($2)`,
          [company.id, allPosIds]
        );
      }
    });

    // Record sync run completion
    await query(
      `UPDATE sync_runs SET status = 'completed', completed_at = NOW(),
       technicians_processed = $2, changes_detected = $3, changes_applied = $4, flags_for_review = $5
       WHERE id = $1`,
      [syncRunId, posTechnicians.length, changesDetected, changesApplied, flagsForReview]
    );

    logger.info({
      syncRunId, company: company.name,
      processed: posTechnicians.length, changes: changesDetected, applied: changesApplied, flagged: flagsForReview,
    }, 'Sync completed for company');

    return {
      syncRunId, companyId: company.id, companyName: company.name,
      techniciansProcessed: posTechnicians.length,
      changesDetected, changesApplied, flagsForReview, events,
    };
  } catch (err) {
    await query(
      `UPDATE sync_runs SET status = 'failed', completed_at = NOW(), error_message = $2 WHERE id = $1`,
      [syncRunId, (err as Error).message]
    );
    logger.error({ syncRunId, company: company.name, err }, 'Sync failed for company');
    throw err;
  }
}

// ══════════════════════════════════════════════
// Scenario handlers
// ══════════════════════════════════════════════

interface HandlerResult {
  applied: number;
  flagged: number;
  events: Array<{ type: SyncEventType; detail: string }>;
}

/**
 * SCENARIO: Technician departure detected (active in TE, inactive in PoS)
 *
 * Business logic:
 * - Deactivate the user on the platform
 * - Release their phone number (set cell_phone = NULL, preserve in last_known_phone)
 * - DO NOT unlink Stripe account - the departed tech should still be able to claim earnings
 *   via a support flow. Unlinking would strand their money.
 * - Log everything for the operations team
 */
async function handleTechnicianDeparture(
  client: PoolClient, syncRunId: string, company: Company,
  localTech: User, posTech: PoSTechnician
): Promise<HandlerResult> {
  const events: Array<{ type: SyncEventType; detail: string }> = [];

  // Deactivate and release phone - atomic within the parent transaction
  await client.query(
    `UPDATE users SET
       is_active = false,
       deactivated_at = NOW(),
       deactivation_reason = 'Deactivated in PoS system (auto-sync)',
       last_known_phone = cell_phone,
       cell_phone = NULL,
       last_synced_at = NOW()
     WHERE id = $1`,
    [localTech.id]
  );

  // Record phone release in audit trail
  if (localTech.cell_phone) {
    await client.query(
      `INSERT INTO phone_number_audit (phone_number, previous_user_id, new_user_id, action, reason)
       VALUES ($1, $2, NULL, 'released', $3)`,
      [normalizePhone(localTech.cell_phone), localTech.id, `Technician deactivated in ${company.pos_provider}`]
    );
  }

  await recordStatusChange(client, {
    userId: localTech.id,
    companyId: company.id,
    previousStatus: 'active',
    newStatus: 'deactivated',
    reason: `Deactivated in ${company.pos_provider}. Phone released. Stripe account preserved for earnings withdrawal.`,
    posTechnicianId: posTech.externalId,
    phoneNumber: localTech.cell_phone,
    requiresReview: false,
  });

  await recordSyncEvent(client, syncRunId, company.id, 'technician_deactivated', localTech.id, posTech.externalId, {
    technicianName: `${localTech.first_name} ${localTech.last_name}`,
    phoneReleased: localTech.cell_phone,
    stripeAccountPreserved: localTech.stripe_account_id,
  });

  // If technician has a Stripe account, log that earnings are preserved
  if (localTech.stripe_account_id) {
    await recordSyncEvent(client, syncRunId, company.id, 'earnings_preserved', localTech.id, posTech.externalId, {
      stripeAccountId: localTech.stripe_account_id,
      note: 'Stripe Connect account kept linked. Departed tech can claim via support.',
    });
    events.push({ type: 'earnings_preserved', detail: `Stripe account ${localTech.stripe_account_id} preserved for ${localTech.first_name} ${localTech.last_name}` });
  }

  events.push({ type: 'technician_deactivated', detail: `${localTech.first_name} ${localTech.last_name} deactivated, phone ${localTech.cell_phone} released` });
  events.push({ type: 'phone_released', detail: `Phone ${localTech.cell_phone} released from ${localTech.first_name} ${localTech.last_name}` });

  return { applied: 1, flagged: 0, events };
}

/**
 * SCENARIO: New technician in PoS not yet in the platform
 *
 * Business logic:
 * - Check for phone number conflicts before onboarding
 * - If the phone belongs to an ACTIVE user → flag for human review (zero tolerance for shared phones)
 * - If the phone belongs to an INACTIVE user → this is likely a phone reassignment
 *   Auto-onboard the new tech since the old user's phone was already released
 * - If no conflict → auto-onboard
 */
async function handleNewTechnician(
  client: PoolClient, syncRunId: string, company: Company,
  posTech: PoSTechnician, localByPhone: Map<string, User>
): Promise<HandlerResult> {
  const events: Array<{ type: SyncEventType; detail: string }> = [];
  const normalizedPhone = posTech.phone;

  // Check for phone conflict
  if (normalizedPhone) {
    const existingUser = localByPhone.get(normalizedPhone);

    // Also check ALL companies, not just this one - phone must be globally unique among active users
    const { rows: globalConflicts } = await client.query(
      `SELECT * FROM users WHERE cell_phone = $1 AND is_active = true`,
      [normalizedPhone]
    );

    if (globalConflicts.length > 0) {
      // ── PHONE CONFLICT: Active user already has this number ──
      // This is the Jane Doe / John Doe scenario. We MUST NOT auto-assign
      // because it could link the wrong financial account.
      const conflictingUser = globalConflicts[0];

      // Idempotency: check if we already have an unresolved review for this exact conflict
      const { rows: existingReviews } = await client.query(
        `SELECT id FROM technician_status_changes
         WHERE pos_technician_id = $1 AND phone_number = $2
           AND requires_review = true AND reviewed_at IS NULL`,
        [posTech.externalId, normalizedPhone]
      );

      if (existingReviews.length > 0) {
        // Already flagged in a previous sync - don't duplicate
        events.push({ type: 'phone_conflict_detected', detail: `Phone ${normalizedPhone} conflict already flagged for ${posTech.firstName} ${posTech.lastName} (skipping duplicate)` });
        return { applied: 0, flagged: 0, events };
      }

      await client.query(
        `INSERT INTO phone_number_audit (phone_number, previous_user_id, new_user_id, action, reason)
         VALUES ($1, $2, NULL, 'conflict_flagged', $3)`,
        [normalizedPhone, conflictingUser.id,
         `New PoS tech ${posTech.firstName} ${posTech.lastName} has phone already assigned to active user ${conflictingUser.first_name} ${conflictingUser.last_name}`]
      );

      await recordStatusChange(client, {
        userId: conflictingUser.id,
        companyId: company.id,
        previousStatus: 'active',
        newStatus: 'active',
        reason: `Phone number conflict: New PoS technician "${posTech.firstName} ${posTech.lastName}" (PoS ID: ${posTech.externalId}) has phone ${normalizedPhone} which belongs to active user "${conflictingUser.first_name} ${conflictingUser.last_name}". Manual resolution required.`,
        posTechnicianId: posTech.externalId,
        phoneNumber: normalizedPhone,
        requiresReview: true,
      });

      await recordSyncEvent(client, syncRunId, company.id, 'phone_conflict_detected', conflictingUser.id, posTech.externalId, {
        newTechName: `${posTech.firstName} ${posTech.lastName}`,
        existingUserName: `${conflictingUser.first_name} ${conflictingUser.last_name}`,
        phone: normalizedPhone,
        action: 'flagged_for_review',
        businessReason: 'Cannot auto-assign phone - risk of linking wrong Stripe account and leaking financial data',
      });

      events.push({ type: 'phone_conflict_detected', detail: `Phone ${normalizedPhone} conflict: new tech ${posTech.firstName} ${posTech.lastName} vs active user ${conflictingUser.first_name} ${conflictingUser.last_name}` });
      return { applied: 0, flagged: 1, events };
    }
  }

  // No conflict - auto-onboard the new technician
  const newUserId = uuidv4();
  await client.query(
    `INSERT INTO users (id, first_name, last_name, cell_phone, email, role, company_id, pos_technician_id, is_active, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, 'technician', $6, $7, true, NOW())`,
    [newUserId, posTech.firstName, posTech.lastName, normalizedPhone, posTech.email, company.id, posTech.externalId]
  );

  // Record phone assignment if applicable
  if (normalizedPhone) {
    // Check if this phone was previously released from someone
    const { rows: previousOwners } = await client.query(
      `SELECT * FROM users WHERE last_known_phone = $1 AND is_active = false AND company_id = $2 ORDER BY deactivated_at DESC LIMIT 1`,
      [normalizedPhone, company.id]
    );

    if (previousOwners.length > 0) {
      // Phone reassignment from departed tech to new hire
      await client.query(
        `INSERT INTO phone_number_audit (phone_number, previous_user_id, new_user_id, action, reason)
         VALUES ($1, $2, $3, 'reassigned', $4)`,
        [normalizedPhone, previousOwners[0].id, newUserId,
         `Phone reassigned from departed tech ${previousOwners[0].first_name} ${previousOwners[0].last_name} to new hire ${posTech.firstName} ${posTech.lastName}`]
      );
      events.push({ type: 'phone_reassigned', detail: `Phone ${normalizedPhone} reassigned from ${previousOwners[0].first_name} ${previousOwners[0].last_name} to ${posTech.firstName} ${posTech.lastName}` });
    }
  }

  await recordStatusChange(client, {
    userId: newUserId,
    companyId: company.id,
    previousStatus: 'active', // they're new, starting as active
    newStatus: 'active',
    reason: `New technician auto-onboarded from ${company.pos_provider}`,
    posTechnicianId: posTech.externalId,
    phoneNumber: normalizedPhone,
    requiresReview: false,
  });

  await recordSyncEvent(client, syncRunId, company.id, 'new_technician_detected', newUserId, posTech.externalId, {
    technicianName: `${posTech.firstName} ${posTech.lastName}`,
    phone: normalizedPhone,
    autoOnboarded: true,
  });

  events.push({ type: 'new_technician_detected', detail: `${posTech.firstName} ${posTech.lastName} auto-onboarded with phone ${normalizedPhone || 'none'}` });
  return { applied: 1, flagged: 0, events };
}

/**
 * SCENARIO: Previously departed technician returns (inactive in TE, active in PoS)
 *
 * Business logic:
 * - Reactivate the user
 * - If their old phone is available, restore it
 * - If their old phone is now taken by someone else, flag for review
 * - Re-linking the same Stripe account is safe here since it's the same person
 */
async function handleTechnicianReturn(
  client: PoolClient, syncRunId: string, company: Company,
  localTech: User, posTech: PoSTechnician
): Promise<HandlerResult> {
  const events: Array<{ type: SyncEventType; detail: string }> = [];
  const newPhone = posTech.phone;

  // Check if the new phone conflicts with anyone
  let phoneToAssign = newPhone;
  let needsReview = false;

  if (newPhone) {
    const { rows: conflicts } = await client.query(
      `SELECT * FROM users WHERE cell_phone = $1 AND is_active = true AND id != $2`,
      [newPhone, localTech.id]
    );

    if (conflicts.length > 0) {
      // Can't auto-assign the phone - someone else has it
      phoneToAssign = null;
      needsReview = true;

      await client.query(
        `INSERT INTO phone_number_audit (phone_number, previous_user_id, new_user_id, action, reason)
         VALUES ($1, $2, $3, 'conflict_flagged', $4)`,
        [newPhone, conflicts[0].id, localTech.id,
         `Returning tech ${localTech.first_name} ${localTech.last_name} has phone already assigned to ${conflicts[0].first_name} ${conflicts[0].last_name}`]
      );

      events.push({ type: 'phone_conflict_detected', detail: `Returning tech ${localTech.first_name} ${localTech.last_name} phone ${newPhone} conflicts with ${conflicts[0].first_name} ${conflicts[0].last_name}` });
    }
  }

  // Reactivate the user
  await client.query(
    `UPDATE users SET
       is_active = true,
       cell_phone = $2,
       deactivated_at = NULL,
       deactivation_reason = NULL,
       last_synced_at = NOW(),
       first_name = $3,
       last_name = $4,
       email = COALESCE($5, email)
     WHERE id = $1`,
    [localTech.id, phoneToAssign, posTech.firstName, posTech.lastName, posTech.email]
  );

  await recordStatusChange(client, {
    userId: localTech.id,
    companyId: company.id,
    previousStatus: 'deactivated',
    newStatus: 'active',
    reason: needsReview
      ? `Technician reactivated in PoS but phone ${newPhone} conflicts with another active user. Reactivated without phone - manual assignment needed.`
      : `Technician returned and reactivated from ${company.pos_provider}`,
    posTechnicianId: posTech.externalId,
    phoneNumber: phoneToAssign,
    requiresReview: needsReview,
  });

  await recordSyncEvent(client, syncRunId, company.id, 'technician_returned', localTech.id, posTech.externalId, {
    technicianName: `${localTech.first_name} ${localTech.last_name}`,
    phoneAssigned: phoneToAssign,
    phoneConflict: needsReview,
    stripeAccountRelinked: localTech.stripe_account_id,
  });

  events.push({ type: 'technician_returned', detail: `${localTech.first_name} ${localTech.last_name} reactivated${needsReview ? ' (phone conflict - needs review)' : ''}` });
  return { applied: 1, flagged: needsReview ? 1 : 0, events };
}

/**
 * Update non-critical metadata (name, email) without triggering lifecycle events.
 */
async function updateTechnicianMetadata(
  client: PoolClient, localTech: User, posTech: PoSTechnician
): Promise<void> {
  const updates: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (posTech.firstName !== localTech.first_name) {
    updates.push(`first_name = $${paramIdx++}`);
    params.push(posTech.firstName);
  }
  if (posTech.lastName !== localTech.last_name) {
    updates.push(`last_name = $${paramIdx++}`);
    params.push(posTech.lastName);
  }
  if (posTech.email && posTech.email !== localTech.email) {
    updates.push(`email = $${paramIdx++}`);
    params.push(posTech.email);
  }

  if (updates.length > 0) {
    updates.push(`last_synced_at = NOW()`);
    params.push(localTech.id);
    await client.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      params
    );
  }
}

// ══════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════

async function recordStatusChange(client: PoolClient, params: {
  userId: string; companyId: string; previousStatus: string; newStatus: string;
  reason: string; posTechnicianId: string | null; phoneNumber: string | null;
  requiresReview: boolean;
}): Promise<void> {
  await client.query(
    `INSERT INTO technician_status_changes
     (user_id, company_id, previous_status, new_status, reason, pos_technician_id, phone_number, requires_review)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [params.userId, params.companyId, params.previousStatus, params.newStatus,
     params.reason, params.posTechnicianId, params.phoneNumber, params.requiresReview]
  );
}

async function recordSyncEvent(
  client: PoolClient, syncRunId: string, companyId: string,
  eventType: SyncEventType, userId: string | null, posTechnicianId: string | null,
  details: Record<string, any>
): Promise<void> {
  await client.query(
    `INSERT INTO sync_events (sync_run_id, company_id, event_type, user_id, pos_technician_id, details, action_taken)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [syncRunId, companyId, eventType, userId, posTechnicianId, JSON.stringify(details), details.action || eventType]
  );
}

/**
 * Run sync for all companies with PoS integrations.
 */
export async function syncAllCompanies(): Promise<SyncResult[]> {
  const { rows: companies } = await query(
    `SELECT * FROM companies WHERE pos_provider != 'none' AND pos_tenant_id IS NOT NULL`
  );

  logger.info({ companyCount: companies.length }, 'Starting sync for all integrated companies');

  const results: SyncResult[] = [];
  for (const company of companies) {
    try {
      const result = await syncCompany(company);
      results.push(result);
    } catch (err) {
      logger.error({ company: company.name, err }, 'Sync failed for company, continuing with others');
      results.push({
        syncRunId: '', companyId: company.id, companyName: company.name,
        techniciansProcessed: 0, changesDetected: 0, changesApplied: 0, flagsForReview: 0,
        events: [{ type: 'no_changes', detail: `Sync failed: ${(err as Error).message}` }],
      });
    }
  }

  return results;
}
