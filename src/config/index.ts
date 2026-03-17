import dotenv from 'dotenv';
dotenv.config();

export const config = {
  database: {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    name: process.env.DATABASE_NAME || 'techlifecycle',
    user: process.env.DATABASE_USER || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/techlifecycle',
  },
  serviceTitan: {
    apiUrl: process.env.SERVICETITAN_API_URL || 'http://localhost:3001',
    clientId: process.env.SERVICETITAN_CLIENT_ID || 'mock-client-id',
    clientSecret: process.env.SERVICETITAN_CLIENT_SECRET || 'mock-client-secret',
  },
  sync: {
    intervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES || '15', 10),
    batchSize: parseInt(process.env.SYNC_BATCH_SIZE || '100', 10),
  },
  server: {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
  },
};
