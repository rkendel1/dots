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
  /** Whatever the provider returned, in the provider's own shape. Never synthesized. */
  result: unknown | null;
  errorCode: string | null;
  error: string | null;

  /* ── Reconciliation ──────────────────────────────────────────────────
   * Everything below is OpenDots' own view of how well it agrees with the
   * provider. It is durable, because the answer must survive a restart: after a
   * restart there is no memory of the last cycle, and a UI that claimed
   * "reconciled recently" from process state would be lying.
   */

  /** When OpenDots last successfully observed this execution from the provider. */
  lastReconciledAt: number | null;
  /**
   * Whether the provider's result payload has actually been retrieved.
   *
   * Distinct from `result !== null`: a terminal execution whose result has not
   * been fetched yet is `completed` with nothing to show, and conflating that
   * with "the provider returned nothing" would hide a pending retrieval.
   */
  resultRetrieved: boolean;
  /**
   * The provider's verifiable receipt, stored verbatim in the provider's own
   * shape. OpenDots deliberately does not model receipt fields: it cannot know
   * them better than Compute does, and re-typing them would make an incompatible
   * Compute change look compatible.
   */
  receipt: unknown | null;
  /** The provider's error kind from the last *failed* reconciliation, if any. */
  reconciliationErrorCode: string | null;
  /** Why the last reconciliation attempt failed, if it did. */
  reconciliationError: string | null;
}

/**
 * Attention — what OpenDots believes a human may need to look at.
 *
 * This is the control plane's own interpretation, not a second copy of any
 * durable record. An item names a *condition* and points at the entity that
 * carries it; the current state of that entity is resolved at read time. That is
 * what stops this from becoming a stale cache of execution status.
 *
 * The vocabulary is deliberately small. Each kind answers one question a person
 * could otherwise only answer by reading raw provider state, and none of them
 * exist to predict notification types that have not been needed yet.
 */
export type AttentionKind =
  /** The provider reported this execution failed. It will not retry itself. */
  | 'execution_failed'
  /**
   * The execution cannot progress: it has no provider identity and has been
   * unable to obtain one, so nothing is running and nothing is running away.
   */
  | 'execution_blocked'
  /** The execution finished but its result has not been retrieved yet. */
  | 'execution_evidence_pending'
  /** OpenDots could not reach the provider, so no execution state is trustworthy. */
  | 'provider_unreachable'
  /** A durable Work/Task state is waiting on a person to decide something. */
  | 'human_decision_required';

export type AttentionSeverity = 'info' | 'warning' | 'critical';

/**
 * The human-facing lifecycle.
 *
 * `acknowledged` is a real, distinct state and not a synonym for `resolved`:
 * acknowledging says "I have seen this", resolving says "this no longer needs
 * anyone". A failed execution stays `open` forever if nobody acts on it, because
 * reaching a terminal state is not the same as being dealt with.
 */
export type AttentionStatus = 'open' | 'acknowledged' | 'resolved';

/** What an attention item points at. Never a copy of it. */
export type AttentionSourceType = 'execution' | 'task' | 'provider';

export interface Attention {
  id: string;
  kind: AttentionKind;
  severity: AttentionSeverity;
  status: AttentionStatus;
  /** One line, stable enough to scan in a list. */
  title: string;
  /** A sentence or two saying why this exists. */
  summary: string;
  sourceType: AttentionSourceType;
  /** The id of the entity carrying the condition — an execution, task, or provider name. */
  sourceId: string;
  createdAt: number;
  updatedAt: number;
  /** When a person acknowledged it. Null until they do. */
  acknowledgedAt: number | null;
  /** When a person resolved it. Null until they do. */
  resolvedAt: number | null;
  /**
   * When OpenDots observed the underlying condition to be false.
   *
   * Distinct from `resolvedAt` on purpose. An outage that clears leaves
   * `conditionClearedAt` set while the item stays `open`, because nobody has
   * decided anything — it simply stopped being a live problem. Conflating the
   * two would let a system observation masquerade as a human decision.
   */
  conditionClearedAt: number | null;
}

/**
 * The live state behind one attention item.
 *
 * Assembled at read time by walking the records the item references, never from
 * a copy stored on the item. Lives in `shared/` because it crosses into the
 * browser as the shape of a response — it is the answer to "why am I seeing
 * this?", and both sides must agree on its shape.
 */
export interface AttentionContext {
  attention: Attention;
  /** The execution carrying the condition, when there is one. */
  execution: Execution | null;
  /** The task the execution belongs to, when it names one. */
  task: Task | null;
  /** Recent runs of that task, newest first. */
  runs: Run[];
  /**
   * True when the referenced entity no longer exists, so the UI can say "this
   * referred to a task that was deleted" instead of rendering an empty panel
   * that looks like a bug.
   */
  sourceMissing: boolean;
}

/** The global decision vocabulary, regardless of attention kind. */
export type DecisionValue = 'approve' | 'reject' | 'retry' | 'dismiss';

export type DecisionActorType = 'human';

export interface Decision {
  id: string;
  attentionId: string;
  decision: DecisionValue;
  actorType: DecisionActorType;
  actorId: string;
  createdAt: number;
}

export interface ProposalRecord {
  id: string;
  attentionId: string;
  agentId: string;
  agentVersion?: string;
  decision: DecisionValue;
  rationale: string;
  createdAt: number;
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

// Configuration types for the Setup UI

/** Secret status metadata: whether configured and where from. */
export interface SecretStatus {
  configured: boolean;
  source?: 'environment' | 'secret-reference'; // future sources
}

/** Configuration field with optional value and secret status. */
export interface ConfigurationField<T = string> {
  configured: boolean;
  value?: T;
  secret?: SecretStatus;
  error?: string;
}

/** Intelligence configuration domain model. */
export interface IntelligenceConfiguration {
  apiUrl?: string;
  wsUrl?: string;
  apiKey: SecretStatus;
  model?: string;
  baseUrl?: string;
}

/** Browser configuration domain model. */
export interface BrowserConfiguration {
  url?: string;
  host?: string;
  port?: number;
  secret: SecretStatus;
}

/** Voice configuration domain model. */
export interface VoiceConfiguration {
  model?: string;
  name?: string;
  apiKey: SecretStatus;
}

/** Slack configuration domain model. */
export interface SlackConfiguration {
  channelName?: string;
  teamId?: string;
  userIds: string[];
  dotId?: string;
}

/** Computer configuration domain model. */
export interface ComputerConfiguration {
  supervisorToken: SecretStatus;
  token: SecretStatus;
  namespace?: string;
  memoryBytes?: number;
  runtime?: string;
  engineSocket?: string;
}

/** Core configuration domain model. */
export interface CoreConfiguration {
  ownerId?: string;
  appOrigin?: string;
  ownerToken: SecretStatus;
}

/** Complete configuration read model. */
export interface ConfigurationReadModel {
  setupComplete: boolean;
  sections: {
    core: CoreConfiguration;
    intelligence: IntelligenceConfiguration;
    browser: BrowserConfiguration;
    voice: VoiceConfiguration;
    slack: SlackConfiguration;
    computers: ComputerConfiguration;
  };
  requirements: ConfigurationRequirement[];
}

/** Configuration requirement for setup completion. */
export interface ConfigurationRequirement {
  id: string;
  section: 'core' | 'intelligence' | 'browser' | 'voice' | 'slack' | 'computers';
  label: string;
  required: boolean;
  configured: boolean;
  valid: boolean;
  source: 'environment' | 'managed' | 'missing';
}

/** Non-secret configuration that can be persisted. */
export interface ManagedConfiguration {
  id: string;
  ownerId: string;
  intelligence?: {
    apiUrl?: string;
    wsUrl?: string;
    model?: string;
    baseUrl?: string;
  };
  browser?: {
    url?: string;
    host?: string;
    port?: number;
  };
  voice?: {
    model?: string;
    name?: string;
  };
  slack?: {
    channelName?: string;
    teamId?: string;
    userIds?: string[];
    dotId?: string;
  };
  computers?: {
    namespace?: string;
    memoryBytes?: number;
    runtime?: string;
    engineSocket?: string;
  };
  appOrigin?: string;
  savedAt: number;
  updatedAt: number;
}

export interface WorkspaceState {
  spaces: Space[];
  dots: Dot[];
  conversations: Conversation[];
  setup: SetupStatus;
  calls: CallReceipt[];
}
