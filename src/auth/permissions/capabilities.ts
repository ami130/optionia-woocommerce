/**
 * The permission matrix, as data.
 *
 * Transcribed from M6.5. It is a table rather than scattered `if` statements so
 * the whole policy can be read in one place and diffed against the plan — a rule
 * spread across twenty controllers is a rule nobody can audit.
 *
 * **Deny by default.** A capability absent from a role's list is denied, and a
 * capability absent from this file does not exist. A new endpoint is inaccessible
 * until it is granted here, which is the correct direction for the mistake to
 * fall.
 */

/** What a tenant member can do. */
export const Capability = {
  OPTION_SETS_VIEW: 'option_sets:view',
  OPTION_SETS_EDIT: 'option_sets:edit',
  OPTION_SETS_DELETE: 'option_sets:delete',
  /** Changes a live storefront and what customers are charged. */
  OPTION_SETS_PUBLISH: 'option_sets:publish',
  OPTION_SETS_ROLLBACK: 'option_sets:rollback',
  PRODUCTS_ASSIGN: 'products:assign',
  STORES_CONNECT: 'stores:connect',
  STORES_ROTATE_CREDENTIAL: 'stores:rotate_credential',
  ANALYTICS_VIEW: 'analytics:view',
  DATA_EXPORT: 'data:export',
  MEMBERS_INVITE: 'members:invite',
  MEMBERS_CHANGE_ROLE: 'members:change_role',
  BILLING_VIEW: 'billing:view',
  BILLING_MANAGE: 'billing:manage',
  SUBSCRIPTION_CANCEL: 'subscription:cancel',
  TENANT_DELETE: 'tenant:delete',
  AUDIT_LOG_VIEW: 'audit_log:view',
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

/** What platform staff can do. Deliberately a separate vocabulary. */
export const StaffCapability = {
  TENANTS_VIEW: 'staff:tenants:view',
  OPS_QUEUE_VIEW: 'staff:ops:view',
  OPS_JOB_RETRY: 'staff:ops:retry',
  IMPERSONATE: 'staff:impersonate',
  MERCHANT_CONFIG_READ: 'staff:merchant_config:read',
  SUBSCRIPTION_ADJUST: 'staff:subscription:adjust',
  REFUND_ISSUE: 'staff:refund:issue',
  PLANS_EDIT: 'staff:plans:edit',
  FEATURE_FLAGS_MANAGE: 'staff:feature_flags:manage',
  STAFF_MANAGE: 'staff:staff:manage',
  TENANT_DATA_DELETE: 'staff:tenant_data:delete',
} as const;

export type StaffCapability = (typeof StaffCapability)[keyof typeof StaffCapability];

/**
 * ⚠️ **There is no `staff:merchant_config:write`, and that is deliberate.**
 *
 * M6.5 denies "edit merchant option config" to every platform role including
 * `super_admin`. Staff diagnose and advise; they do not silently change what a
 * merchant's customers are charged.
 *
 * A genuine change goes through consented, time-boxed, audit-logged impersonation
 * and is attributed to the merchant, so the trail is honest about who acted.
 * Omitting the capability entirely — rather than granting it to nobody — means it
 * cannot be granted by editing one line.
 */

/**
 * Tenant roles to capabilities.
 *
 * The separations each have a reason, and the reasons are why this is a table
 * rather than a hierarchy:
 *
 * - **`editor` cannot publish.** Editing is safe; publishing changes a live
 *   storefront and what customers pay. An agency contractor should be able to
 *   build an option set without pushing it live. This is the single most
 *   important line in the matrix.
 * - **`billing` sees money, not configuration.** A bookkeeper needs invoices, not
 *   the option builder.
 * - **`admin` does everything operational but cannot change roles, alter billing
 *   or delete the tenant.** Those are ownership acts.
 * - **Only `owner` changes roles**, so an `admin` cannot escalate themselves or a
 *   peer to `owner`.
 *
 * Roles are not ranked. `billing` can do things `editor` cannot and vice versa,
 * so any implementation ordering them by "level" would be wrong.
 */
export const TENANT_CAPABILITIES: Readonly<Record<string, readonly Capability[]>> = {
  owner: [
    Capability.OPTION_SETS_VIEW,
    Capability.OPTION_SETS_EDIT,
    Capability.OPTION_SETS_DELETE,
    Capability.OPTION_SETS_PUBLISH,
    Capability.OPTION_SETS_ROLLBACK,
    Capability.PRODUCTS_ASSIGN,
    Capability.STORES_CONNECT,
    Capability.STORES_ROTATE_CREDENTIAL,
    Capability.ANALYTICS_VIEW,
    Capability.DATA_EXPORT,
    Capability.MEMBERS_INVITE,
    Capability.MEMBERS_CHANGE_ROLE,
    Capability.BILLING_VIEW,
    Capability.BILLING_MANAGE,
    Capability.SUBSCRIPTION_CANCEL,
    Capability.TENANT_DELETE,
    Capability.AUDIT_LOG_VIEW,
  ],
  admin: [
    Capability.OPTION_SETS_VIEW,
    Capability.OPTION_SETS_EDIT,
    Capability.OPTION_SETS_DELETE,
    Capability.OPTION_SETS_PUBLISH,
    Capability.OPTION_SETS_ROLLBACK,
    Capability.PRODUCTS_ASSIGN,
    Capability.STORES_CONNECT,
    Capability.STORES_ROTATE_CREDENTIAL,
    Capability.ANALYTICS_VIEW,
    Capability.DATA_EXPORT,
    Capability.MEMBERS_INVITE,
    Capability.AUDIT_LOG_VIEW,
  ],
  editor: [
    Capability.OPTION_SETS_VIEW,
    Capability.OPTION_SETS_EDIT,
    Capability.PRODUCTS_ASSIGN,
    Capability.ANALYTICS_VIEW,
  ],
  viewer: [Capability.OPTION_SETS_VIEW, Capability.ANALYTICS_VIEW],
  billing: [Capability.ANALYTICS_VIEW, Capability.BILLING_VIEW, Capability.BILLING_MANAGE],
} as const;

/** Platform staff roles to capabilities. */
export const STAFF_CAPABILITIES: Readonly<Record<string, readonly StaffCapability[]>> = {
  super_admin: [
    StaffCapability.TENANTS_VIEW,
    StaffCapability.OPS_QUEUE_VIEW,
    StaffCapability.OPS_JOB_RETRY,
    StaffCapability.IMPERSONATE,
    StaffCapability.MERCHANT_CONFIG_READ,
    StaffCapability.SUBSCRIPTION_ADJUST,
    StaffCapability.REFUND_ISSUE,
    StaffCapability.PLANS_EDIT,
    StaffCapability.FEATURE_FLAGS_MANAGE,
    StaffCapability.STAFF_MANAGE,
    StaffCapability.TENANT_DATA_DELETE,
  ],
  support: [
    StaffCapability.TENANTS_VIEW,
    StaffCapability.OPS_QUEUE_VIEW,
    StaffCapability.OPS_JOB_RETRY,
    StaffCapability.IMPERSONATE,
    StaffCapability.MERCHANT_CONFIG_READ,
  ],
  billing_ops: [
    StaffCapability.TENANTS_VIEW,
    StaffCapability.OPS_QUEUE_VIEW,
    StaffCapability.SUBSCRIPTION_ADJUST,
    StaffCapability.REFUND_ISSUE,
  ],
  read_only: [
    StaffCapability.TENANTS_VIEW,
    StaffCapability.OPS_QUEUE_VIEW,
    StaffCapability.MERCHANT_CONFIG_READ,
  ],
} as const;

/**
 * Whether a tenant role holds a capability.
 *
 * An unknown role holds nothing. That matters: a role added to the database
 * without being added here is inert rather than unrestricted, so the failure is a
 * 403 someone reports rather than an escalation nobody sees.
 */
export function tenantRoleCan(role: string | undefined, capability: Capability): boolean {
  if (!role) {
    return false;
  }

  return TENANT_CAPABILITIES[role]?.includes(capability) ?? false;
}

/** Whether a staff role holds a capability. Unknown roles hold nothing. */
export function staffRoleCan(role: string | undefined, capability: StaffCapability): boolean {
  if (!role) {
    return false;
  }

  return STAFF_CAPABILITIES[role]?.includes(capability) ?? false;
}
