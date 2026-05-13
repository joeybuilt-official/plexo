// Unit test environment setup for @plexo/mcp-server
// No real DB connections in unit tests — each test file mocks @plexo/db
process.env.DATABASE_URL = 'postgresql://plexo:FAKE_LOCAL_PASSWORD@localhost:5432/plexo'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.NODE_ENV = 'test'
process.env.ENCRYPTION_SECRET = 'test-secret-at-least-32-characters-long'
