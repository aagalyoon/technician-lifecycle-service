import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { logger } from '../config/logger';
import { PoSProvider, PoSTechnician, ServiceTitanResponse, ServiceTitanTechnician } from '../models/types';
import { normalizePhone } from '../utils/phone';
import { withRetry } from '../utils/retry';
import { registerProvider } from './base';

class ServiceTitanProvider implements PoSProvider {
  name = 'servicetitan';
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.serviceTitan.apiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Fetch all technicians for a tenant using batch pagination.
   * ServiceTitan has no webhooks, so we poll GET /tenant/{tenantId}/technicians.
   */
  async fetchTechnicians(tenantId: string): Promise<PoSTechnician[]> {
    const allTechnicians: PoSTechnician[] = [];
    let page = 1;
    const pageSize = config.sync.batchSize;
    let hasMore = true;

    while (hasMore) {
      const response = await withRetry(
        () => this.client.get<ServiceTitanResponse>(
          `/tenant/${tenantId}/technicians`,
          { params: { page, pageSize } }
        ),
        `ServiceTitan fetch page ${page} for tenant ${tenantId}`
      );

      const { data } = response;

      for (const tech of data.data) {
        allTechnicians.push(this.mapTechnician(tech));
      }

      logger.debug(
        { tenantId, page, fetched: data.data.length, total: data.totalCount },
        'Fetched ServiceTitan technician page'
      );

      hasMore = data.hasMore;
      page++;
    }

    logger.info(
      { tenantId, totalFetched: allTechnicians.length },
      'Completed ServiceTitan technician fetch'
    );

    return allTechnicians;
  }

  private mapTechnician(st: ServiceTitanTechnician): PoSTechnician {
    return {
      externalId: String(st.id),
      firstName: st.firstName,
      lastName: st.lastName,
      email: st.email,
      phone: normalizePhone(st.phoneNumber),
      active: st.active,
    };
  }
}

// Self-register on import
const provider = new ServiceTitanProvider();
registerProvider(provider);

export default provider;
