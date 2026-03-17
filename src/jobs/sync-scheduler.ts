import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../config/logger';
import { syncAllCompanies } from '../services/sync-engine';

let syncInProgress = false;

/**
 * Schedule periodic sync with PoS systems.
 * Uses a mutex to prevent overlapping runs.
 */
export function startSyncScheduler(): void {
  const minutes = config.sync.intervalMinutes;
  const cronExpression = `*/${minutes} * * * *`;

  logger.info({ intervalMinutes: minutes, cron: cronExpression }, 'Starting sync scheduler');

  cron.schedule(cronExpression, async () => {
    if (syncInProgress) {
      logger.warn('Sync already in progress, skipping this cycle');
      return;
    }

    syncInProgress = true;
    try {
      logger.info('Scheduled sync starting');
      const results = await syncAllCompanies();
      const totalChanges = results.reduce((sum, r) => sum + r.changesDetected, 0);
      const totalFlags = results.reduce((sum, r) => sum + r.flagsForReview, 0);
      logger.info(
        { companies: results.length, totalChanges, totalFlags },
        'Scheduled sync completed'
      );
    } catch (err) {
      logger.error({ err }, 'Scheduled sync failed');
    } finally {
      syncInProgress = false;
    }
  });
}
