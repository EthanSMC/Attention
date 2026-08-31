import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { adminEntitlementAudits } from "./schema";

describe("admin entitlement audit database schema", () => {
  it("stores the complete immutable entitlement change envelope", () => {
    const config = getTableConfig(adminEntitlementAudits);

    expect(config.columns.map((column) => column.name)).toEqual([
      "id",
      "actor_account_id",
      "target_account_id",
      "action",
      "previous_state",
      "next_state",
      "reason",
      "source",
      "request_id",
      "occurred_at",
    ]);
    expect(adminEntitlementAudits.actorAccountId.notNull).toBe(true);
    expect(adminEntitlementAudits.targetAccountId.notNull).toBe(true);
    expect(adminEntitlementAudits.previousState.getSQLType()).toBe("jsonb");
    expect(adminEntitlementAudits.nextState.getSQLType()).toBe("jsonb");
  });

  it("indexes actor/target history and constrains audit values", () => {
    const config = getTableConfig(adminEntitlementAudits);

    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "admin_entitlement_audits_actor_time_idx",
        "admin_entitlement_audits_target_time_idx",
        "admin_entitlement_audits_request_idx",
      ]),
    );
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "admin_entitlement_audits_action_allowed",
        "admin_entitlement_audits_reason_not_blank",
        "admin_entitlement_audits_source_not_blank",
        "admin_entitlement_audits_request_not_blank",
        "admin_entitlement_audits_state_shape",
      ]),
    );
  });
});
