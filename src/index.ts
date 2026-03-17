import express from 'express';
import cors from 'cors';
import path from 'path';
import { config } from './config';
import { logger } from './config/logger';

// Import provider to trigger self-registration
import './providers/servicetitan';

import healthRouter from './routes/health';
import syncRouter from './routes/sync';
import reviewsRouter from './routes/reviews';
import { startSyncScheduler } from './jobs/sync-scheduler';

const app = express();

app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, _res, next) => {
  logger.debug({ method: req.method, url: req.url }, 'Request');
  next();
});

// Routes
app.use('/health', healthRouter);
app.use('/api/sync', syncRouter);
app.use('/api/reviews', reviewsRouter);

// Serve dashboard - resolve path from project root
const dashboardPath = path.resolve(__dirname, '..', '..', 'dashboard');
app.use('/dashboard', express.static(dashboardPath));

// Start server
const server = app.listen(config.server.port, () => {
  logger.info({ port: config.server.port, env: config.server.nodeEnv }, 'Technician Lifecycle Service started');

  // Start the background sync scheduler
  startSyncScheduler();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

export default app;
