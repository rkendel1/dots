import type { Collection, StateFirstDB } from '@feltdb/core';
import type {
  ComputerAudit,
  ComputerPermissions,
} from '../shared/computer-types.js';
import { byTimestampDesc, type StorageFence } from './felt/records.js';

/**
 * FeltDB storage for the state `ComputerStore` owns.
 *
 * Two collections: the per-Dot permission policy, and the audit log with its
 * per-Dot retention cap. Nothing about a computer's *lifecycle*, control
 * handback, browser profile or session is stored here — `ComputerService`
 * derives all of that from the OpenBot supervisor on every call — so there is
 * no such collection to migrate.
 */

/** One Dot's computer permission policy. */
export interface ComputerPermissionRecord
  extends ComputerPermissions, StorageFence {
  dotId: string;
}

/**
 * One audited computer action.
 *
 * `pending` rows are never trimmed by the retention pass, which is what lets an
 * in-flight action survive.
 */
export interface ComputerAuditRecord extends StorageFence {
  id: string;
  dotId: string;
  action: string;
  actor: ComputerAudit['actor'];
  outcome: ComputerAudit['outcome'];
  createdAt: number;
}

export interface ComputerCollections {
  permissions: Collection<ComputerPermissionRecord>;
  audit: Collection<ComputerAuditRecord>;
}

export function computerCollections(db: StateFirstDB): ComputerCollections {
  return {
    permissions: db.collection<ComputerPermissionRecord>(
      'computer_permissions',
    ),
    audit: db.collection<ComputerAuditRecord>('computer_audit'),
  };
}

/** The permission policy a Dot has when it has never been configured. */
export const DEFAULT_PERMISSIONS: ComputerPermissions = {
  enabled: false,
  browser: false,
  files: false,
  shell: false,
};

/** How many finished audit rows to keep per Dot. */
export const AUDIT_RETENTION = 1000;

/** How many audit rows the status panel reads per Dot. */
export const AUDIT_READ_LIMIT = 50;

export function toPermissions(
  record: ComputerPermissionRecord,
): ComputerPermissions {
  return {
    enabled: record.enabled,
    browser: record.browser,
    files: record.files,
    shell: record.shell,
  };
}

/** Strip the storage fence; `ComputerAudit` already has a domain `id`. */
export function toAudit(record: ComputerAuditRecord): ComputerAudit {
  const { __version: _fence, ...audit } = record;
  void _fence;
  return {
    id: audit.id,
    action: audit.action,
    actor: audit.actor,
    outcome: audit.outcome,
    createdAt: audit.createdAt,
  };
}

export { byTimestampDesc as byAuditCreatedAtDesc };
