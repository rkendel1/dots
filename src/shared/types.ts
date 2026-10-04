export type Status =
  'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface Settings {
  name: string;
  paused: boolean;
  researchAllowed: boolean;
  memoryAllowed: boolean;
}
export interface Task {
  id: string;
  prompt: string;
  status: Status;
  intervalSeconds: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  lease: string | null;
  leaseUntil: number | null;
}
/**
 * The lifecycle OpenDots owns for an external execution.
 *
 * Deliberately coarser than any provider's own vocabulary. Compute's `JobStatus`
 * has thirteen values; the domain needs to know only whether work is waiting,
 * getting going, under way, or finished, and which of the three terminal outcomes
 * it reached. The provider's exact word is kept separately on `ExecutionRecord` as
 * `providerStatus`, so this normalization is auditable rather than lossy.
 */
export type ExecutionStatus =
  'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * One external execution OpenDots has asked a provider to perform.
 *
 * This is deliberately distinct from `Run`. A `Run` is a research attempt made
 * *inside* this process: a task claim creates it, its id is the lease, and only
 * the worker holding that lease may finish it. An execution is owned by an
 * external provider, outlives the request that asked for it, carries the
 * provider's identity so it can be reconciled after a restart, and is
 * idempotent on submission.
 */
export interface Execution {
  id: string;
  /** The task this execution was requested for, when it came from one. */
  taskId: string | null;
  /** The Dot this execution was requested for, when it came from one. */
  dotId: string | null;
  status: ExecutionStatus;
  /** The provider that owns this execution, e.g. `compute`. */
  provider: string;
  /** The provider's own identifier — Compute's `job_id`. */
  providerExecutionId: string | null;
  /** The provider's session identity, when it ran inside one. */
  providerSessionId: string | null;
  /** The provider's raw status word, kept verbatim alongside the normalized one. */
  providerStatus: string | null;
  /** Stable across retries of the same request; unique per execution. */
  idempotencyKey: string;
  /** What OpenDots was asked to run. Never a provider-specific instruction. */
  prompt: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /** Whatever the provider returned, in its own shape. Never synthesized. */
  result: unknown | null;
  errorCode: string | null;
  error: string | null;
}

export interface Source {
  title: string;
  url: string;
  excerpt: string;
}
export interface Result {
  text: string;
  sources: Source[];
  sample: boolean;
  screenshot?: string;
}
export interface Run {
  id: string;
  taskId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  result: Result | null;
  error: string | null;
}
export interface TaskEvent {
  id: number;
  taskId: string;
  runId: string | null;
  text: string;
  createdAt: number;
}
export interface Memory {
  id: string;
  text: string;
  createdAt: number;
}
export interface Detail {
  task: Task;
  runs: Run[];
  events: TaskEvent[];
}
export interface State {
  settings: Settings;
  tasks: Task[];
  memories: Memory[];
  mode: 'sample' | 'live';
  configured: boolean;
}
export type Action = 'run' | 'pause' | 'cancel';
export interface Space {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}
export interface Dot {
  id: string;
  /** Default destination for saved pages, not ownership. */
  spaceId: string;
  spaceIds: string[];
  name: string;
  instructions: string;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  createdAt: number;
  learningContainerId?: string | null;
  skillDeliveryEnabled?: boolean;
}
export interface Conversation {
  id: string;
  dotId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  /** Frozen at creation; null means this conversation does not participate. */
  learningContainerId?: string | null;
}
export interface CallReceipt {
  anchorMessageId?: string | null;
  id: string;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  status: 'connecting' | 'active' | 'ended' | 'failed';
  transcript: string;
  error: string | null;
}
export interface SetupStatus {
  intelligence: boolean;
  model: boolean;
  browser: boolean;
  voice: boolean;
  slack: string;
  missing: string[];
}
export interface WorkspaceState {
  spaces: Space[];
  dots: Dot[];
  conversations: Conversation[];
  setup: SetupStatus;
  calls: CallReceipt[];
}
