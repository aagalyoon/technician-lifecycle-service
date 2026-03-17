import { query, withTransaction } from '../models/database';
import { logger } from '../config/logger';
import { normalizePhone } from '../utils/phone';

export interface PendingReview {
  id: string;
  user_id: string;
  company_id: string;
  company_name: string;
  technician_name: string;
  previous_status: string;
  new_status: string;
  reason: string;
  phone_number: string | null;
  pos_technician_id: string | null;
  created_at: Date;
}

export interface ReviewResolution {
  reviewId: string;
  resolution: string;
  reviewedBy: string;
  // Optional actions to take
  releasePhone?: boolean;
  reassignPhoneTo?: string; // user_id to reassign phone to
  deactivateUser?: string; // user_id to deactivate
  newPhoneNumber?: string; // assign a new phone number to the conflicted user
}

/**
 * Get all items pending human review.
 */
export async function getPendingReviews(): Promise<PendingReview[]> {
  const { rows } = await query(`
    SELECT tsc.*, c.name as company_name,
           CONCAT(u.first_name, ' ', u.last_name) as technician_name
    FROM technician_status_changes tsc
    JOIN companies c ON c.id = tsc.company_id
    JOIN users u ON u.id = tsc.user_id
    WHERE tsc.requires_review = true AND tsc.reviewed_at IS NULL
    ORDER BY tsc.created_at DESC
  `);
  return rows;
}

/**
 * Resolve a flagged review item.
 *
 * This is where a human operator handles the ambiguous cases:
 * - Phone number conflicts (the Jane Doe / John Doe scenario)
 * - Technicians missing from PoS roster
 * - Returning techs with phone conflicts
 */
export async function resolveReview(resolution: ReviewResolution): Promise<void> {
  await withTransaction(async (client) => {
    // Mark the review as resolved
    await client.query(
      `UPDATE technician_status_changes
       SET reviewed_at = NOW(), reviewed_by = $2, resolution = $3
       WHERE id = $1`,
      [resolution.reviewId, resolution.reviewedBy, resolution.resolution]
    );

    // Execute resolution actions
    if (resolution.releasePhone) {
      // Release a phone number from a specific user
      const { rows } = await client.query(
        `SELECT id, cell_phone, first_name, last_name FROM users WHERE id = (
           SELECT user_id FROM technician_status_changes WHERE id = $1
         )`,
        [resolution.reviewId]
      );
      if (rows[0]?.cell_phone) {
        await client.query(
          `UPDATE users SET last_known_phone = cell_phone, cell_phone = NULL WHERE id = $1`,
          [rows[0].id]
        );
        await client.query(
          `INSERT INTO phone_number_audit (phone_number, previous_user_id, action, reason)
           VALUES ($1, $2, 'released', $3)`,
          [rows[0].cell_phone, rows[0].id, `Manual release by ${resolution.reviewedBy}: ${resolution.resolution}`]
        );
        logger.info({ userId: rows[0].id, phone: rows[0].cell_phone }, 'Phone released via review');
      }
    }

    if (resolution.reassignPhoneTo) {
      const { rows: reviewRows } = await client.query(
        `SELECT phone_number FROM technician_status_changes WHERE id = $1`,
        [resolution.reviewId]
      );
      const phone = reviewRows[0]?.phone_number;
      if (phone) {
        // Ensure no active user has this phone
        const { rows: conflicts } = await client.query(
          `SELECT id FROM users WHERE cell_phone = $1 AND is_active = true`,
          [phone]
        );
        if (conflicts.length > 0) {
          throw new Error(`Cannot reassign phone ${phone} - still assigned to active user ${conflicts[0].id}`);
        }
        await client.query(
          `UPDATE users SET cell_phone = $2 WHERE id = $1`,
          [resolution.reassignPhoneTo, phone]
        );
        await client.query(
          `INSERT INTO phone_number_audit (phone_number, new_user_id, action, reason)
           VALUES ($1, $2, 'reassigned', $3)`,
          [phone, resolution.reassignPhoneTo, `Manual reassignment by ${resolution.reviewedBy}: ${resolution.resolution}`]
        );
      }
    }

    if (resolution.deactivateUser) {
      await client.query(
        `UPDATE users SET is_active = false, deactivated_at = NOW(),
         deactivation_reason = $2, last_known_phone = cell_phone, cell_phone = NULL
         WHERE id = $1`,
        [resolution.deactivateUser, `Manual deactivation via review: ${resolution.resolution}`]
      );
    }

    if (resolution.newPhoneNumber) {
      const normalizedNew = normalizePhone(resolution.newPhoneNumber);
      if (!normalizedNew) {
        throw new Error(`Invalid phone number: ${resolution.newPhoneNumber}`);
      }
      // Ensure this new phone isn't taken
      const { rows: taken } = await client.query(
        `SELECT id FROM users WHERE cell_phone = $1 AND is_active = true`,
        [normalizedNew]
      );
      if (taken.length > 0) {
        throw new Error(`Phone ${normalizedNew} already assigned to user ${taken[0].id}`);
      }
      const { rows: reviewRows } = await client.query(
        `SELECT user_id FROM technician_status_changes WHERE id = $1`,
        [resolution.reviewId]
      );
      await client.query(
        `UPDATE users SET cell_phone = $1 WHERE id = $2`,
        [normalizedNew, reviewRows[0].user_id]
      );
    }

    logger.info({ reviewId: resolution.reviewId, resolution: resolution.resolution }, 'Review resolved');
  });
}

/**
 * Get dashboard metrics for the operations team.
 */
export async function getDashboardMetrics() {
  const [
    pendingReviewsResult,
    recentSyncsResult,
    turnoverStatsResult,
    phoneConflictsResult,
    activeCompaniesResult,
  ] = await Promise.all([
    query(`SELECT COUNT(*) as count FROM technician_status_changes WHERE requires_review = true AND reviewed_at IS NULL`),
    query(`SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 20`),
    query(`
      SELECT
        c.name as company_name,
        COUNT(CASE WHEN tsc.new_status = 'deactivated' THEN 1 END) as departures,
        COUNT(CASE WHEN tsc.new_status = 'active' AND tsc.previous_status = 'deactivated' THEN 1 END) as returns,
        COUNT(CASE WHEN se.event_type = 'new_technician_detected' THEN 1 END) as new_hires
      FROM companies c
      LEFT JOIN technician_status_changes tsc ON tsc.company_id = c.id AND tsc.created_at > NOW() - INTERVAL '30 days'
      LEFT JOIN sync_events se ON se.company_id = c.id AND se.created_at > NOW() - INTERVAL '30 days'
      WHERE c.pos_provider != 'none'
      GROUP BY c.id, c.name
    `),
    query(`
      SELECT COUNT(*) as count FROM phone_number_audit
      WHERE action = 'conflict_flagged' AND created_at > NOW() - INTERVAL '30 days'
    `),
    query(`
      SELECT c.*, COUNT(u.id) FILTER (WHERE u.is_active AND u.role = 'technician') as active_techs,
             COUNT(u.id) FILTER (WHERE NOT u.is_active AND u.role = 'technician') as inactive_techs
      FROM companies c
      LEFT JOIN users u ON u.company_id = c.id
      WHERE c.pos_provider != 'none'
      GROUP BY c.id
    `),
  ]);

  return {
    pendingReviews: parseInt(pendingReviewsResult.rows[0].count),
    recentSyncs: recentSyncsResult.rows,
    turnoverByCompany: turnoverStatsResult.rows,
    phoneConflictsLast30Days: parseInt(phoneConflictsResult.rows[0].count),
    companies: activeCompaniesResult.rows,
  };
}
