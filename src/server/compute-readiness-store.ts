/**
 * Durable Compute readiness state in FeltDB.
 *
 * Compute readiness is persisted so that OpenDots can survive a restart without
 * losing what it knew about Compute's capabilities. This is part of the cold-start
 * recovery model: a restarted process does not inherit process memory, it
 * reconstructs itself from durable state.
 */

import type { StateFirstDB } from '@feltdb/core';
import { withoutStorageFields } from './felt/records.js';
import type {
  ComputeReadinessReport,
  ComputeRuntime,
} from './compute-capability-discovery.js';
import type { StorageFence } from './felt/records.js';

export interface ComputeReadinessRecord extends StorageFence {
  id: string;
  available: boolean;
  protocol?: string;
  version?: string;
  capabilities?: Record<string, unknown>;
  runtimes?: ComputeRuntime[];
  checkedAt: number;
  error?: string;
  errorCode?: string;
}

const READINESS_ID = 'current';

/**
 * Manage Compute readiness state in FeltDB.
 *
 * There is only one row (id = 'current'), which is overwritten on each check.
 * Cold-start recovery reads this row to answer "what did we last know about Compute?"
 */
export class ComputeReadinessStore {
  private db: StateFirstDB;

  constructor(db: StateFirstDB) {
    this.db = db;
  }

  /**
   * Read the current Compute readiness state.
   */
  async current(): Promise<ComputeReadinessRecord | undefined> {
    const collection = this.db.collection<ComputeReadinessRecord>('compute_readiness');
    const row = await collection.get(READINESS_ID);
    return row ? withoutStorageFields(row) : undefined;
  }

  /**
   * Update Compute readiness state with a fresh report.
   */
  async update(report: ComputeReadinessReport): Promise<void> {
    const now = Date.now();

    const record: ComputeReadinessRecord = {
      id: READINESS_ID,
      available: report.available,
      protocol: report.protocol,
      version: report.version,
      capabilities: report.capabilities,
      runtimes: report.runtimes,
      checkedAt: now,
      error: report.error,
      errorCode: report.errorCode,
    };

    await this.db.transaction((tx) => {
      void tx
        .collection<ComputeReadinessRecord>('compute_readiness')
        .set(READINESS_ID, record);
    });
  }

  /**
   * Get all runtimes from the current readiness state.
   */
  async runtimes(): Promise<ComputeRuntime[]> {
    const state = await this.current();
    return state?.runtimes ?? [];
  }

  /**
   * Check if a specific runtime is available.
   */
  async hasRuntime(name: string): Promise<boolean> {
    const runtimes = await this.runtimes();
    return runtimes.some((r) => r.runtime === name);
  }
}
