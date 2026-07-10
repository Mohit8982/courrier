// Test env: overrides .env values for the Jest suite.
// Loaded via jest.config.ts `setupFiles`.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.DATABASE_URL =
  process.env.DATABASE_URL_TEST ||
  'postgresql://courier:courier_pass@127.0.0.1:5432/courier_platform_test?schema=public';
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '6379';
process.env.RETRY_MAX_ATTEMPTS = '3';
process.env.RETRY_INITIAL_DELAY_MS = '10'; // fast retry in tests
process.env.RETRY_MAX_DELAY_MS = '50';
process.env.RETRY_BACKOFF_FACTOR = '2';
process.env.BULK_MAX_ORDERS = '100';
process.env.BULK_CONCURRENCY = '2';
process.env.URBANEBOLT_BASE_URL = 'https://uat.urbanebolt.in';
process.env.URBANEBOLT_USERNAME = 'test-user';
process.env.URBANEBOLT_PASSWORD = 'test-pass';
process.env.MOCK_COURIER_BASE_URL = 'https://mock-courier.local';
process.env.MOCK_COURIER_API_KEY = 'mock-test-key';
