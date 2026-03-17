import { Router, Request, Response } from 'express';
import { query } from '../models/database';

const router = Router();

/**
 * GET /health
 * Health check endpoint. Verifies database connectivity.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    await query('SELECT 1');
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      error: 'Database connection failed',
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
