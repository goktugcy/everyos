/**
 * Fine-grained permissions. Roles are only bundles of these permissions; every
 * authorization decision in the API and the agent is made against a permission,
 * never against a role name.
 */
export const PERMISSIONS = [
  "system:read",
  "system:manage",
  "services:read",
  "services:manage",
  "logs:read",
  "docker:read",
  "docker:manage",
  /** Deleting Docker data (volumes). Granted to administrators only. */
  "docker:delete",
  "apps:read",
  "apps:manage",
  "catalogs:manage",
  "files:read",
  "files:write",
  "terminal:access",
  "notifications:read",
  "backups:manage",
  /** Restoring and downloading backups (they hold every account's data). Administrators only. */
  "backups:restore",
  "tasks:manage",
  "users:manage",
  "settings:manage",
  "audit:read",
  "preferences:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["admin", "operator", "viewer"] as const;

export type Role = (typeof ROLES)[number];

const VIEWER_PERMISSIONS: readonly Permission[] = [
  "preferences:manage",
  "system:read",
  "services:read",
  "docker:read",
  "apps:read",
  "notifications:read",
];

const OPERATOR_PERMISSIONS: readonly Permission[] = [
  ...VIEWER_PERMISSIONS,
  "services:manage",
  "logs:read",
  "docker:manage",
  "apps:manage",
  "files:read",
  "files:write",
  "backups:manage",
  "tasks:manage",
];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  admin: new Set(PERMISSIONS),
  operator: new Set(OPERATOR_PERMISSIONS),
  viewer: new Set(VIEWER_PERMISSIONS),
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

export function permissionsForRole(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
