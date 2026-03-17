import { Router, Request, Response } from 'express';
import { syncAllCompanies, syncCompany } from '../services/sync-engine';
import { query } from '../models/database';
import { logger } from '../config/logger';

const router = Router();

/**
 * POST /api/sync
 * Trigger a sync for all integrated companies.
 */
router.post('/', async (_req: Request, res: Response) => {
  try {
    logger.info('Manual sync triggered via API');
    const results = await syncAllCompanies();
    res.json({
      success: true,
      results: results.map((r) => ({
        company: r.companyName,
        syncRunId: r.syncRunId,
        techniciansProcessed: r.techniciansProcessed,
        changesDetected: r.changesDetected,
        changesApplied: r.changesApplied,
        flagsForReview: r.flagsForReview,
        events: r.events,
      })),
    });
  } catch (err) {
    logger.error({ err }, 'Sync API error');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * POST /api/sync/:companyId
 * Trigger sync for a specific company.
 */
router.post('/:companyId', async (req: Request, res: Response) => {
  try {
    const { rows } = await query('SELECT * FROM companies WHERE id = $1', [req.params.companyId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }
    const result = await syncCompany(rows[0]);
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, 'Sync API error');
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

/**
 * GET /api/sync/history
 * Get recent sync run history.
 */
router.get('/history', async (_req: Request, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT sr.*, c.name as company_name
       FROM sync_runs sr
       JOIN companies c ON c.id = sr.company_id
       ORDER BY sr.started_at DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/sync/:syncRunId/events
 * Get events for a specific sync run.
 */
router.get('/:syncRunId/events', async (req: Request, res: Response) => {
  try {
    const { rows } = await query(
      `SELECT * FROM sync_events WHERE sync_run_id = $1 ORDER BY created_at`,
      [req.params.syncRunId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
