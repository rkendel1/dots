/**
 * Compute 0.1.17 capability and runtime discovery.
 *
 * Speaks the real `compute.remote@1` protocol to discover what a connected Compute
 * environment can actually do. Never invents capabilities or infers runtimes from
 * CLI names — all information comes from Compute itself.
 *
 * Compute is responsible for execution. OpenDots is responsible for knowing what
 * Compute reports about its own capabilities.
 */

export interface ComputeCapability {
  name: string;
  supported: boolean;
}

export interface ComputeRuntime {
  runtime: string;
  status: string;
  version: string;
  executable?: string;
  source: string;
}

export interface ComputeReadinessReport {
  available: boolean;
  protocol?: string;
  version?: string;
  capabilities?: Record<string, unknown>;
  runtimes?: ComputeRuntime[];
  error?: string;
  errorCode?: string;
}

interface ComputeHealthResponse {
  status?: string;
  version?: string;
}

interface ComputeRuntimesResponse {
  compute_version?: string;
  runtimes?: Array<{
    runtime: string;
    status: string;
    version: string;
    executable?: string;
    source: string;
  }>;
}

const COMPUTE_PROTOCOL = 'compute.remote@1';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Discover Compute capabilities by speaking the real compute.remote@1 protocol.
 */
export class ComputeCapabilityDiscovery {
  private readonly endpoint: string;
  private readonly authorization?: string;
  private readonly timeoutMs: number;

  constructor(endpoint: string, authorization?: string, timeoutMs?: number) {
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.authorization = authorization;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Execute a raw HTTP request to Compute using compute.remote@1.
   */
  private async call<T>(method: 'GET', path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.endpoint}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          'X-Compute-Protocol': COMPUTE_PROTOCOL,
          ...(this.authorization ? { Authorization: this.authorization } : {}),
        },
      });

      const text = await response.text();

      if (!response.ok) {
        throw new Error(
          `Compute returned HTTP ${response.status}: ${text.slice(0, 200)}`,
        );
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Compute returned an unreadable response to ${method} ${path}`);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `Compute did not answer ${method} ${path} within ${this.timeoutMs}ms.`,
        );
      }
      throw new Error(
        `Could not reach Compute at ${this.endpoint}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Check if Compute is reachable and report basic health.
   */
  async health(): Promise<ComputeReadinessReport> {
    try {
      const response = await this.call<ComputeHealthResponse>('GET', '/compute/health');

      return {
        available: true,
        protocol: COMPUTE_PROTOCOL,
        version: response.version,
      };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: 'health_check_failed',
      };
    }
  }

  /**
   * Discover available runtimes from Compute.
   */
  async runtimes(): Promise<ComputeReadinessReport> {
    try {
      const response = await this.call<ComputeRuntimesResponse>(
        'GET',
        '/compute/runtimes',
      );

      const runtimes = (response.runtimes ?? []).map((r) => ({
        runtime: r.runtime,
        status: r.status,
        version: r.version,
        executable: r.executable,
        source: r.source,
      }));

      return {
        available: true,
        protocol: COMPUTE_PROTOCOL,
        version: response.compute_version,
        runtimes,
      };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
        errorCode: 'runtime_discovery_failed',
      };
    }
  }

  /**
   * Full readiness check: health + runtimes.
   *
   * Compute is ready if both health check succeeds and at least one runtime is
   * available. The capabilities and runtimes are persisted separately so that
   * partial information is still useful (e.g., health succeeded but runtimes
   * discovery failed, or vice versa).
   */
  async fullReadinessCheck(): Promise<ComputeReadinessReport> {
    const healthReport = await this.health();

    if (!healthReport.available) {
      return healthReport;
    }

    const runtimesReport = await this.runtimes();

    // Merge reports: both succeeded → report both
    if (runtimesReport.available && runtimesReport.runtimes) {
      return {
        available: true,
        protocol: COMPUTE_PROTOCOL,
        version: healthReport.version ?? runtimesReport.version,
        runtimes: runtimesReport.runtimes,
      };
    }

    // Health succeeded but runtimes failed → partial report
    return {
      available: true,
      protocol: COMPUTE_PROTOCOL,
      version: healthReport.version,
      error: runtimesReport.error,
      errorCode: runtimesReport.errorCode,
    };
  }
}

/**
 * Build capability discovery from environment.
 *
 * Returns `undefined` when no endpoint is configured, which is the normal case:
 * OpenDots must start, run and be fully usable without Compute present.
 */
export function capabilityDiscoveryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ComputeCapabilityDiscovery | undefined {
  const endpoint = env.COMPUTE_ENDPOINT?.trim();
  if (!endpoint) return undefined;

  return new ComputeCapabilityDiscovery(
    endpoint,
    env.COMPUTE_AUTHORIZATION?.trim(),
  );
}
