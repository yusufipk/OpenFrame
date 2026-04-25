import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, PoolConfig } from 'pg';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const globalForPool = globalThis as unknown as {
  pgPool: Pool | undefined;
};

const isDbPoolDebugEnabled = process.env.DB_POOL_DEBUG === 'true';

function createPool(connectionString: string): Pool {
  // Prevent multiple pools from being created during development (Next.js hot reload)
  if (globalForPool.pgPool) {
    return globalForPool.pgPool;
  }

  const poolConfig: PoolConfig = {
    connectionString,
    max: 20, // Maximum number of connections
    idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
    connectionTimeoutMillis: 5000, // Return error after 5 seconds if can't connect
  };

  const pool = new Pool(poolConfig);

  // Add error handling for pool errors
  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err.message);
    // Don't crash the app on unexpected pool errors
  });

  if (isDbPoolDebugEnabled) {
    pool.on('connect', () => {
      console.debug('New database connection established');
    });

    pool.on('acquire', () => {
      console.debug('Connection acquired from pool');
    });
  }

  // Store pool globally to prevent multiple instances during development
  if (process.env.NODE_ENV !== 'production') {
    globalForPool.pgPool = pool;
  }

  return pool;
}

function createPrismaClient() {
  // In development without a database, we'll create a mock-friendly client
  // For production or when DATABASE_URL is set, use the real adapter
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.warn('DATABASE_URL not set - database features will not work');
    // Return a client that will throw clear errors when used
    const pool = createPool('postgresql://localhost:5432/dummy');
    return new PrismaClient({
      // This will fail on actual DB operations but allows imports to work
      adapter: new PrismaPg(pool),
    });
  }

  const pool = createPool(connectionString);
  const adapter = new PrismaPg(pool);

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db;
}

export async function disconnectDb(): Promise<void> {
  if (globalForPool.pgPool) {
    await globalForPool.pgPool.end();
    globalForPool.pgPool = undefined;
  }
  await db.$disconnect();
}

// Graceful shutdown handler
async function shutdown() {
  console.log('Shutting down database connections...');
  await disconnectDb();
  console.log('Database connections closed');
}

// Register shutdown handlers
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default db;
