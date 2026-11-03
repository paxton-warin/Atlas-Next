process.env.NODE_ENV = "test";
process.env.APP_URL ??= "http://localhost:3000";
process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ??
  "postgres://test:test@localhost:55432/atlas_dispenser_test";
process.env.REDIS_URL ??=
  process.env.TEST_REDIS_URL ?? "redis://localhost:56379/15";
process.env.SESSION_SECRET ??=
  "test-session-secret-that-is-more-than-thirty-two-bytes";
process.env.DATA_ENCRYPTION_KEY ??=
  "test-encryption-secret-that-will-be-hashed";
process.env.BOOTSTRAP_ADMIN_EMAIL ??= "admin@example.com";
process.env.BOOTSTRAP_TOKEN ??= "test-bootstrap-token-that-is-long-enough";
process.env.GOOGLE_REDIRECT_URI ??=
  "http://localhost:3000/api/admin/google/callback";
