import express from 'express';
import { logger } from './data';

/**
 * Mock ServiceTitan API Server
 *
 * Simulates the ServiceTitan /tenant/{tenantId}/technicians endpoint
 * with realistic data that exercises all lifecycle scenarios:
 *
 * Tenant 100 (Apex Plumbing):
 *   - st-tech-101: Jane Doe - still active (no change)
 *   - st-tech-102: Bob Smith - NOW DEACTIVATED (simulates departure)
 *   - st-tech-103: Carlos Rivera - NOW DEACTIVATED (simulates departure with phone reassignment)
 *   - st-tech-104: NEW Maria Garcia - new hire, has Carlos's old phone (phone reassignment)
 *   - st-tech-105: NEW Dave Wilson - new hire with phone that conflicts with Diana Chen at Elite
 *
 * Tenant 200 (Elite Electrical):
 *   - st-tech-201: Diana Chen - still active
 *   - st-tech-202: Erik Johnson - NOW DEACTIVATED
 *   - st-tech-203: NEW Frank Lee - new hire, no phone conflicts
 */

import { tenantData } from './data';

const app = express();
app.use(express.json());

// GET /tenant/:tenantId/technicians - paginated technician list
app.get('/tenant/:tenantId/technicians', (req, res) => {
  const { tenantId } = req.params;
  const page = parseInt(req.query.page as string) || 1;
  const pageSize = parseInt(req.query.pageSize as string) || 50;

  const tenant = tenantData[tenantId];
  if (!tenant) {
    return res.status(404).json({ error: `Tenant ${tenantId} not found` });
  }

  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  const pageData = tenant.slice(start, end);

  logger.info(`[Mock ST] GET /tenant/${tenantId}/technicians page=${page} - returning ${pageData.length} of ${tenant.length}`);

  res.json({
    page,
    pageSize,
    totalCount: tenant.length,
    hasMore: end < tenant.length,
    data: pageData,
  });
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'mock-servicetitan' });
});

const PORT = process.env.MOCK_ST_PORT || 3001;
app.listen(PORT, () => {
  logger.info(`[Mock ServiceTitan] Running on port ${PORT}`);
  logger.info(`[Mock ServiceTitan] Tenants available: ${Object.keys(tenantData).join(', ')}`);
});
