/**
 * Idempotency-Key ownership races (token-based claims).
 *
 * - claim returns a private token; only the token holder may complete.
 * - A stale owner (claim expired, key re-claimed) cannot overwrite the
 *   newer owner's pending claim via completion.
 * - A stale owner cannot delete a newer owner's claim on failure cleanup.
 * - Same key + same body replays; same key + different body 409s.
 */

const RedisMock = require('ioredis-mock');
const redis = require('../../src/infrastructure/redis');
const store = require('../../src/infrastructure/batchStore');

const TTL = 300;

describe('Idempotency ownership', () => {
  beforeAll(() => {
    redis.setRedisImplementation(RedisMock);
  });

  afterAll(async () => {
    await redis.closeRedis();
  });

  it('claim returns distinct tokens; second claim loses while first holds', async () => {
    const key = `owner-a-${Date.now()}`;
    const tokenA = await store.claimIdempotencyKey(key, TTL);
    expect(typeof tokenA).toBe('string');
    expect(tokenA.length).toBeGreaterThan(0);

    const tokenB = await store.claimIdempotencyKey(key, TTL);
    expect(tokenB).toBeNull();

    const record = await store.getIdempotencyRecord(key);
    expect(record).toMatchObject({ status: 'pending', token: tokenA });
  });

  it('only the owner token may complete; stale token gets false', async () => {
    const key = `owner-b-${Date.now()}`;
    const tokenA = await store.claimIdempotencyKey(key, TTL);
    expect(tokenA).toBeTruthy();

    // Stale/forged token cannot complete someone else's claim.
    expect(
      await store.completeIdempotencyRecord(
        key,
        'forged-token',
        { batchId: 'BATCH-X', bodyHash: 'h' },
        TTL,
      ),
    ).toBe(false);

    // The original claim is untouched.
    expect(await store.getIdempotencyRecord(key)).toMatchObject({
      status: 'pending',
      token: tokenA,
    });

    // Owner completes successfully.
    expect(
      await store.completeIdempotencyRecord(
        key,
        tokenA,
        { batchId: 'BATCH-A', bodyHash: 'hash-a' },
        TTL,
      ),
    ).toBe(true);
    expect(await store.getIdempotencyRecord(key)).toMatchObject({
      status: 'complete',
      batchId: 'BATCH-A',
      bodyHash: 'hash-a',
    });
  });

  it('expired claim + second request: stale first request cannot overwrite', async () => {
    const key = `owner-c-${Date.now()}`;
    const tokenA = await store.claimIdempotencyKey(key, TTL);
    expect(tokenA).toBeTruthy();

    // Simulate claim expiry + re-claim by request B (slow request A).
    const client = await redis.getRedisClient();
    await client.del(`idempotency:${key}`);
    const tokenB = await store.claimIdempotencyKey(key, TTL);
    expect(tokenB).toBeTruthy();
    expect(tokenB).not.toBe(tokenA);

    // Stale A finishes and tries to complete: rejected, B's claim survives.
    expect(
      await store.completeIdempotencyRecord(
        key,
        tokenA,
        { batchId: 'BATCH-STALE-A', bodyHash: 'hash-a' },
        TTL,
      ),
    ).toBe(false);
    expect(await store.getIdempotencyRecord(key)).toMatchObject({
      status: 'pending',
      token: tokenB,
    });

    // B completes normally.
    expect(
      await store.completeIdempotencyRecord(
        key,
        tokenB,
        { batchId: 'BATCH-B', bodyHash: 'hash-b' },
        TTL,
      ),
    ).toBe(true);
    expect(await store.getIdempotencyRecord(key)).toMatchObject({
      status: 'complete',
      batchId: 'BATCH-B',
    });
  });

  it('stale owner cleanup cannot delete a newer owner claim', async () => {
    const key = `owner-d-${Date.now()}`;
    const tokenA = await store.claimIdempotencyKey(key, TTL);

    // Expire + re-claim by B.
    const client = await redis.getRedisClient();
    await client.del(`idempotency:${key}`);
    const tokenB = await store.claimIdempotencyKey(key, TTL);

    // Stale A fails and cleans up: must NOT disturb B.
    expect(await store.deleteIdempotencyKeyIfOwner(key, tokenA)).toBe(false);
    expect(await store.getIdempotencyRecord(key)).toMatchObject({
      status: 'pending',
      token: tokenB,
    });

    // Owner B cleans up its own claim successfully.
    expect(await store.deleteIdempotencyKeyIfOwner(key, tokenB)).toBe(true);
    expect(await store.getIdempotencyRecord(key)).toBeNull();
  });

  it('owner cleanup of a missing key succeeds (nothing to clean)', async () => {
    expect(await store.deleteIdempotencyKeyIfOwner(`nope-${Date.now()}`, 'any-token')).toBe(true);
  });
});
