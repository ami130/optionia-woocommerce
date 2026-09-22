import {
  Capability,
  STAFF_CAPABILITIES,
  StaffCapability,
  staffRoleCan,
  TENANT_CAPABILITIES,
  tenantRoleCan,
} from './capabilities';

/**
 * The permission matrix, asserted cell by cell against M6.5.
 *
 * Every cell, not a sample. A matrix is exactly the kind of thing where a single
 * wrong entry is invisible on reading and catastrophic in use — and the wrong
 * entries that matter are the ✅s that should be —.
 */
describe('permission matrix', () => {
  /**
   * Transcribed from the plan's table. Written as the grid rather than as
   * assertions so a reviewer can diff it against the document directly.
   */
  const TENANT_MATRIX: Array<[Capability, string[]]> = [
    [Capability.OPTION_SETS_VIEW, ['owner', 'admin', 'editor', 'viewer']],
    [Capability.OPTION_SETS_EDIT, ['owner', 'admin', 'editor']],
    [Capability.OPTION_SETS_DELETE, ['owner', 'admin']],
    [Capability.OPTION_SETS_PUBLISH, ['owner', 'admin']],
    [Capability.OPTION_SETS_ROLLBACK, ['owner', 'admin']],
    [Capability.PRODUCTS_ASSIGN, ['owner', 'admin', 'editor']],
    [Capability.STORES_CONNECT, ['owner', 'admin']],
    [Capability.STORES_ROTATE_CREDENTIAL, ['owner', 'admin']],
    [Capability.ANALYTICS_VIEW, ['owner', 'admin', 'editor', 'viewer', 'billing']],
    [Capability.DATA_EXPORT, ['owner', 'admin']],
    [Capability.MEMBERS_INVITE, ['owner', 'admin']],
    [Capability.MEMBERS_CHANGE_ROLE, ['owner']],
    [Capability.BILLING_VIEW, ['owner', 'billing']],
    [Capability.BILLING_MANAGE, ['owner', 'billing']],
    [Capability.SUBSCRIPTION_CANCEL, ['owner']],
    [Capability.TENANT_DELETE, ['owner']],
    [Capability.AUDIT_LOG_VIEW, ['owner', 'admin']],
  ];

  const ALL_TENANT_ROLES = ['owner', 'admin', 'editor', 'viewer', 'billing'];

  describe.each(TENANT_MATRIX)('%s', (capability, allowed) => {
    it.each(ALL_TENANT_ROLES)(`is %s correct`, (role) => {
      expect(tenantRoleCan(role, capability)).toBe(allowed.includes(role));
    });
  });

  describe('the separations that carry the most weight', () => {
    /**
     * The single most important line in the matrix. Editing is safe; publishing
     * changes a live storefront and what customers are charged, so an agency
     * contractor can build without pushing live.
     */
    it('editor can edit but cannot publish', () => {
      expect(tenantRoleCan('editor', Capability.OPTION_SETS_EDIT)).toBe(true);
      expect(tenantRoleCan('editor', Capability.OPTION_SETS_PUBLISH)).toBe(false);
      expect(tenantRoleCan('editor', Capability.OPTION_SETS_ROLLBACK)).toBe(false);
    });

    /** So an admin cannot escalate themselves or a peer to owner. */
    it('admin cannot change roles, alter billing, or delete the tenant', () => {
      expect(tenantRoleCan('admin', Capability.MEMBERS_CHANGE_ROLE)).toBe(false);
      expect(tenantRoleCan('admin', Capability.BILLING_MANAGE)).toBe(false);
      expect(tenantRoleCan('admin', Capability.SUBSCRIPTION_CANCEL)).toBe(false);
      expect(tenantRoleCan('admin', Capability.TENANT_DELETE)).toBe(false);
    });

    /** A bookkeeper needs invoices, not the option builder. */
    it('billing sees money but not configuration', () => {
      expect(tenantRoleCan('billing', Capability.BILLING_VIEW)).toBe(true);
      expect(tenantRoleCan('billing', Capability.OPTION_SETS_VIEW)).toBe(false);
      expect(tenantRoleCan('billing', Capability.OPTION_SETS_EDIT)).toBe(false);
    });

    it('viewer can change nothing', () => {
      const mutating = [
        Capability.OPTION_SETS_EDIT,
        Capability.OPTION_SETS_DELETE,
        Capability.OPTION_SETS_PUBLISH,
        Capability.PRODUCTS_ASSIGN,
        Capability.STORES_CONNECT,
        Capability.MEMBERS_INVITE,
      ];

      mutating.forEach((c) => expect(tenantRoleCan('viewer', c)).toBe(false));
    });
  });

  describe('deny by default', () => {
    /**
     * A role added to the database without being added here must be inert, not
     * unrestricted — a 403 someone reports rather than an escalation nobody sees.
     */
    it('grants an unknown role nothing', () => {
      Object.values(Capability).forEach((c) => {
        expect(tenantRoleCan('superuser', c)).toBe(false);
        expect(tenantRoleCan('', c)).toBe(false);
        expect(tenantRoleCan(undefined, c)).toBe(false);
      });
    });

    it('grants no tenant role a capability outside the matrix', () => {
      const declared = new Set<string>(Object.values(Capability));

      Object.values(TENANT_CAPABILITIES)
        .flat()
        .forEach((c) => expect(declared.has(c)).toBe(true));
    });
  });

  describe('platform staff', () => {
    const STAFF_MATRIX: Array<[StaffCapability, string[]]> = [
      [StaffCapability.TENANTS_VIEW, ['super_admin', 'support', 'billing_ops', 'read_only']],
      [StaffCapability.OPS_QUEUE_VIEW, ['super_admin', 'support', 'billing_ops', 'read_only']],
      [StaffCapability.OPS_JOB_RETRY, ['super_admin', 'support']],
      [StaffCapability.IMPERSONATE, ['super_admin', 'support']],
      [StaffCapability.MERCHANT_CONFIG_READ, ['super_admin', 'support', 'read_only']],
      [StaffCapability.SUBSCRIPTION_ADJUST, ['super_admin', 'billing_ops']],
      [StaffCapability.REFUND_ISSUE, ['super_admin', 'billing_ops']],
      [StaffCapability.PLANS_EDIT, ['super_admin']],
      [StaffCapability.FEATURE_FLAGS_MANAGE, ['super_admin']],
      [StaffCapability.STAFF_MANAGE, ['super_admin']],
      [StaffCapability.TENANT_DATA_DELETE, ['super_admin']],
    ];

    const ALL_STAFF_ROLES = ['super_admin', 'support', 'billing_ops', 'read_only'];

    describe.each(STAFF_MATRIX)('%s', (capability, allowed) => {
      it.each(ALL_STAFF_ROLES)(`is %s correct`, (role) => {
        expect(staffRoleCan(role, capability)).toBe(allowed.includes(role));
      });
    });

    /**
     * ⚠️ The most important assertion in this file.
     *
     * M6.5 denies "edit merchant option config" to every platform role including
     * super_admin. Staff diagnose and advise; they do not silently change what a
     * merchant's customers are charged. A genuine change goes through consented,
     * audit-logged impersonation.
     *
     * The capability is absent entirely rather than granted to nobody, so it
     * cannot be enabled by editing one line — this test fails the moment anyone
     * adds it.
     */
    it('gives no platform role the ability to write merchant config', () => {
      const all = Object.values(STAFF_CAPABILITIES).flat().map(String);

      expect(all.some((c) => /merchant_config:(write|edit)/.test(c))).toBe(false);
      expect(Object.values(StaffCapability).map(String)).not.toContain(
        'staff:merchant_config:write',
      );
    });

    it('grants an unknown staff role nothing', () => {
      Object.values(StaffCapability).forEach((c) => {
        expect(staffRoleCan('root', c)).toBe(false);
        expect(staffRoleCan(undefined, c)).toBe(false);
      });
    });
  });

  /**
   * The two vocabularies must not overlap. A shared string would let a tenant
   * capability satisfy a staff check, which is the realm separation collapsing
   * quietly.
   */
  it('keeps the tenant and staff vocabularies disjoint', () => {
    const tenant = new Set<string>(Object.values(Capability));
    const staff = Object.values(StaffCapability).map(String);

    staff.forEach((c) => expect(tenant.has(c)).toBe(false));
  });
});
