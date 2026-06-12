import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RedisClient } from "../adapters/redis.js";
import type { Rule } from "../core/types.js";

/**
 * Tenant + rule persistence (service layer, over the Redis adapter).
 *
 * Key layout:
 *   throttle:tenants:<sha256(apiKey)>  -> tenantId          (API keys never stored in clear)
 *   throttle:tenant-index             -> SET of tenantIds   (existence checks)
 *   throttle:rules:{<tenantId>}       -> HASH ruleId -> JSON(Rule)   (hash-tagged per tenant)
 *
 * API keys are stored only as a sha256 digest: a Redis dump never leaks usable
 * credentials, and lookup stays an O(1) GET on the digest.
 */
export class TenantStore {
  constructor(private readonly redis: RedisClient) {}

  private apiKeyField(apiKey: string): string {
    return `throttle:tenants:${sha256(apiKey)}`;
  }

  private rulesKey(tenantId: string): string {
    return `throttle:rules:{${tenantId}}`;
  }

  /** Create a tenant and its first API key. The key is returned once and never recoverable. */
  async createTenant(): Promise<{ tenantId: string; apiKey: string }> {
    const tenantId = randomUUID();
    const apiKey = `tk_${randomBytes(24).toString("hex")}`;
    await this.redis.set(this.apiKeyField(apiKey), tenantId);
    await this.redis.sadd("throttle:tenant-index", tenantId);
    return { tenantId, apiKey };
  }

  async tenantIdForApiKey(apiKey: string): Promise<string | null> {
    return this.redis.get(this.apiKeyField(apiKey));
  }

  /** Provision a tenant with a KNOWN id + key. Idempotent — used by the seed
   *  script so demo credentials are stable across restarts. */
  async seedTenant(tenantId: string, apiKey: string): Promise<void> {
    await this.redis.set(this.apiKeyField(apiKey), tenantId);
    await this.redis.sadd("throttle:tenant-index", tenantId);
  }

  async tenantExists(tenantId: string): Promise<boolean> {
    return (await this.redis.sismember("throttle:tenant-index", tenantId)) === 1;
  }

  async putRule(tenantId: string, rule: Rule): Promise<void> {
    await this.redis.hset(this.rulesKey(tenantId), rule.ruleId, JSON.stringify(rule));
  }

  async getRule(tenantId: string, ruleId: string): Promise<Rule | null> {
    const raw = await this.redis.hget(this.rulesKey(tenantId), ruleId);
    return raw ? (JSON.parse(raw) as Rule) : null;
  }

  async listRules(tenantId: string): Promise<Rule[]> {
    const all = await this.redis.hgetall(this.rulesKey(tenantId));
    return Object.values(all).map((v) => JSON.parse(v) as Rule);
  }

  async deleteRule(tenantId: string, ruleId: string): Promise<boolean> {
    return (await this.redis.hdel(this.rulesKey(tenantId), ruleId)) > 0;
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
