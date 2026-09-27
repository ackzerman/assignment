/**
 * Embedded Redis opt-in flag (no-op path).
 *
 * EMBEDDED_REDIS is strictly opt-in: when unset, startup must not touch the
 * redis-memory-server package at all (production installs may omit it).
 */

const { startEmbeddedRedisIfEnabled } = require('../../src/infrastructure/redis');

describe('Embedded Redis opt-in', () => {
  const OLD_ENV = process.env.EMBEDDED_REDIS;

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.EMBEDDED_REDIS;
    else process.env.EMBEDDED_REDIS = OLD_ENV;
  });

  it('does nothing when EMBEDDED_REDIS is not set', async () => {
    delete process.env.EMBEDDED_REDIS;
    await expect(startEmbeddedRedisIfEnabled()).resolves.toBeNull();
  });

  it('does nothing for values other than "1"', async () => {
    process.env.EMBEDDED_REDIS = '0';
    await expect(startEmbeddedRedisIfEnabled()).resolves.toBeNull();
  });
});
