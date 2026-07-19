// Deterministic, non-secret test-only configuration. Real credentials must only
// be supplied through the deployment environment or an ignored local .env file.
process.env.NODE_ENV = 'test';
process.env.CRYPTO_STORE_BACKEND = 'json';
process.env.DATA_DIR = '.data-test';
process.env.UNIFOLD_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.TREASURY_ACCOUNT_ID = 'ta_test_not_a_real_account';
process.env.CRYPTO_SERVICE_TOKEN = 'test-only-crypto-service-token-0123456789abcdef';
process.env.UNIFOLD_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
// Pin the cash-out minimum for the suite (the shipping default is now $1 for the
// demo); these tests exercise enforcement at a $20 configured minimum.
process.env.CASHOUT_THRESHOLD_UNITS = '20000000';
