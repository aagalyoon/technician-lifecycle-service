import { Router, Request, Response } from 'express';
import { getPendingReviews, resolveReview, getDashboardMetrics } from '../services/review-service';
import { logger } from '../config/logger';

const router = Router();

/**
 * GET /api/reviews
 * List all pending review items for the operations team.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const reviews = await getPendingReviews();
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/reviews/:reviewId/resolve
 * Resolve a flagged item.
 *
 * Body: {
 *   resolution: string,       // Description of what was decided
 *   reviewedBy: string,       // Who resolved it
 *   releasePhone?: boolean,   // Release the phone from the flagged user
 *   reassignPhoneTo?: string, // User ID to give the phone to
 *   deactivateUser?: string,  // User ID to deactivate
 *   newPhoneNumber?: string,  // Assign a different phone number
 * }
 */
router.post('/:reviewId/resolve', async (req: Request, res: Response) => {
  try {
    const { resolution, reviewedBy, releasePhone, reassignPhoneTo, deactivateUser, newPhoneNumber } = req.body;
    if (!resolution || !reviewedBy) {
      return res.status(400).json({ error: 'resolution and reviewedBy are required' });
    }

    await resolveReview({
      reviewId: req.params.reviewId,
      resolution,
      reviewedBy,
      releasePhone,
      reassignPhoneTo,
      deactivateUser,
      newPhoneNumber,
    });

    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'Review resolution error');
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /api/dashboard
 * Operational dashboard metrics.
 */
router.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    const metrics = await getDashboardMetrics();
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
