import { randomUUID } from 'node:crypto';
import type { AtomicTransactionScope, StateFirstDB } from '@feltdb/core';
import {
  isLostRace,
  transactionId,
  withoutStorageFields,
} from './felt/records.js';
import {
  AUDIT_READ_LIMIT,
  AUDIT_RETENTION,
  DEFAULT_PERMISSIONS,
  byAuditCreatedAtDesc,
  type ComputerAuditRecord,
  type ComputerCollections,
} from './computer-collections.js';
import type {
  ComputerAudit,
  ComputerPermissions,
} from '../shared/computer-types.js';

/** Bounded retries for a lost conditional write. */
const MAX_ATTEMPTS = 8;

/**
 * Per-Dot computer permission policy, and the audit log of computer actions.
 *
 * The `state.db` handle is owned by the application; this store never opens or
 * closes it. Nothing here describes a computer's lifecycle, control or session:
 * `ComputerService` re-derives all of that from the OpenBot supervisor on every
 * call, so there is no such record to persist.
 *
 * SQLite stored the policy as a JSON blob and had no optimistic concurrency.
 * Both are now structured and fenced, which keeps the observable merge
 * behaviour while removing the lost-update window a plain read-merge-write had.
 */
export class ComputerStore {
  constructor(
    private readonly state: StateFirstDB,
    private readonly felt: ComputerCollections,
  ) {}

  private commit(prefix: string, stage: (tx: AtomicTransactionScope) => void) {
    return this.state.transaction(stage, {
      transactionId: transactionId(prefix),
    });
  }

  async permissions(id: string): Promise<ComputerPermissions> {
    const record = await this.felt.permissions.get(id);
    return record
      ? {
          enabled: record.enabled,
          browser: record.browser,
          files: record.files,
          shell: record.shell,
        }
      : { ...DEFAULT_PERMISSIONS };
  }

  /** Merge a patch, fenced on the version that was read. */
  async patch(
    id: string,
    patch: Partial<ComputerPermissions>,
  ): Promise<ComputerPermissions> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const existing = await this.felt.permissions.get(id);
      const value: ComputerPermissions = {
        ...(existing
          ? {
              enabled: existing.enabled,
              browser: existing.browser,
              files: existing.files,
              shell: existing.shell,
            }
          : DEFAULT_PERMISSIONS),
        ...patch,
      };
      const version = existing?.__version ?? 0;
      try {
        await this.commit('computer-permissions', (tx) => {
          tx.collection('computer_permissions').set(
            id,
            { dotId: id, ...value, __version: version + 1 },
            existing ? { expectedVersion: version } : { requireAbsent: true },
          );
        });
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
      return value;
    }
    throw new Error('That permission policy changed too often to save.');
  }

  /** Open an audit receipt. Create-only: the id is generated here. */
  async begin(
    dotId: string,
    action: string,
    actor: 'owner' | 'agent',
  ): Promise<string> {
    const id = randomUUID();
    await this.commit('computer-audit-begin', (tx) => {
      tx.collection<ComputerAuditRecord>('computer_audit').set(
        id,
        {
          id,
          dotId,
          action,
          actor,
          outcome: 'pending',
          createdAt: Date.now(),
          __version: 1,
        },
        { requireAbsent: true },
      );
    });
    return id;
  }
  /**
   * Close an audit receipt and apply per-Dot retention.
   *
   * One transaction, where SQLite used two unprotected statements: the trim's
   * cut-off is `ORDER BY createdAt DESC, rowid DESC`, so it has to observe the
   * outcome this very call writes. `rowid DESC` is reverse insertion order, and
   * insertion order is what `all()` already returns.
   *
   * Pending rows are never trimmed, so an in-flight action cannot be deleted
   * out from under itself. An unknown id is a no-op, as before.
   */
  async finish(id: string, outcome: 'succeeded' | 'failed'): Promise<void> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const record = await this.felt.audit.get(id);
      if (!record) return;
      const version = record.__version ?? 1;
      const expired = (await this.finishedRows(record.dotId)).slice(
        AUDIT_RETENTION,
      );
      try {
        await this.commit('computer-audit-finish', (tx) => {
          tx.collection<ComputerAuditRecord>('computer_audit').set(
            id,
            {
              ...withoutStorageFields(record),
              outcome,
              __version: version + 1,
            },
            { expectedVersion: version },
          );
          for (const stale of expired)
            tx.collection<ComputerAuditRecord>('computer_audit').delete(
              stale.id,
            );
        });
        return;
      } catch (error) {
        if (isLostRace(error)) continue;
        throw error;
      }
    }
  }

  /** This Dot's finished audit rows, newest first by `createdAt DESC, rowid DESC`. */
  private async finishedRows(dotId: string) {
    return byAuditCreatedAtDesc(
      (await this.felt.audit.all()).filter(
        (row) => row.dotId === dotId && row.outcome !== 'pending',
      ),
    );
  }

  async audit(id: string): Promise<ComputerAudit[]> {
    const rows = byAuditCreatedAtDesc(
      (await this.felt.audit.all()).filter((row) => row.dotId === id),
    );
    return rows.slice(0, AUDIT_READ_LIMIT).map((row) => ({
      id: row.id,
      action: row.action,
      actor: row.actor,
      outcome: row.outcome,
      createdAt: row.createdAt,
    }));
  }
}
