import type { Collection, StateFirstDB } from '@feltdb/core';
import type { Execution } from '../shared/types.js';
import {
  isLostRace,
  transactionId,
  withoutStorageFields,
  type StorageFence,
} from './felt/records.js';

export { isLostRace, transactionId };
export { withoutStorageFields };
export type { StorageFence };

/**
 * FeltDB storage for the executions the `ExecutionStore` owns.
 *
 * Field names match `feltdb.flow` exactly, so `toExecution` is a pure
 * storage-metadata strip with no mapping layer — the same relationship
 * `store-collections.ts` has with the rest of the schema.
 */
export interface ExecutionRecord extends Execution, StorageFence {}

export interface ExecutionCollections {
  executions: Collection<ExecutionRecord>;
}

export function executionCollections(db: StateFirstDB): ExecutionCollections {
  return {
    executions: db.collection<ExecutionRecord>('executions'),
  };
}

/**
 * Strip FeltDB's own metadata before a record crosses the application boundary.
 *
 * The execution's own `id` replaces the storage key, which is the same
 * convention `toTask` and `toRun` follow.
 *
 * The reconciliation fields are defaulted rather than passed through as
 * `undefined`: a record written before this PR existed has no `lastReconciledAt`
 * key at all, and every consumer should see the same shape regardless of when the
 * execution was created.
 */
export function toExecution(record: ExecutionRecord): Execution {
  return {
    ...withoutStorageFields(record),
    id: record.id,
    lastReconciledAt: record.lastReconciledAt ?? null,
    resultRetrieved: record.resultRetrieved ?? false,
    receipt: record.receipt ?? null,
    reconciliationErrorCode: record.reconciliationErrorCode ?? null,
    reconciliationError: record.reconciliationError ?? null,
  };
}
