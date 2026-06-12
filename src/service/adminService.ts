import type { Rule } from "../core/types.js";
import type { TenantStore } from "./tenantStore.js";
import type { RuleCache } from "./ruleCache.js";
import { parseRule } from "./validation.js";
import { UnknownTenantError } from "./errors.js";

/**
 * Tenant + rule administration behind the admin API key. Thin layer over
 * TenantStore that validates tenant existence and keeps the local rule cache
 * coherent after writes.
 */
export class AdminService {
  constructor(
    private readonly tenants: TenantStore,
    private readonly rules: RuleCache,
  ) {}

  createTenant(): Promise<{ tenantId: string; apiKey: string }> {
    return this.tenants.createTenant();
  }

  async putRule(tenantId: string, ruleId: string, body: unknown): Promise<Rule> {
    await this.requireTenant(tenantId);
    const rule = parseRule(ruleId, body);
    await this.tenants.putRule(tenantId, rule);
    this.rules.invalidate(tenantId, ruleId); // this instance sees the change at once
    return rule;
  }

  async listRules(tenantId: string): Promise<Rule[]> {
    await this.requireTenant(tenantId);
    return this.tenants.listRules(tenantId);
  }

  async deleteRule(tenantId: string, ruleId: string): Promise<boolean> {
    await this.requireTenant(tenantId);
    const removed = await this.tenants.deleteRule(tenantId, ruleId);
    this.rules.invalidate(tenantId, ruleId);
    return removed;
  }

  private async requireTenant(tenantId: string): Promise<void> {
    if (!(await this.tenants.tenantExists(tenantId))) {
      throw new UnknownTenantError(tenantId);
    }
  }
}
