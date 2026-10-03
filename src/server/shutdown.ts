export function createShutdown(options: {
  /** Awaitable because `Runner.stop()` requeues its claims in durable state. */
  stopRunner: () => void | Promise<void>;
  stopPlatform: () => Promise<void>;
  closeServer: () => Promise<void>;
  /**
   * Release process-wide resources such as the durable state lock.
   * Runs after the HTTP server stops accepting connections.
   */
  closeState?: () => void;
  exit: (code: number) => void;
  report: (operation: string, error: unknown) => void;
  timeoutMs?: number;
}) {
  let pending: Promise<void> | undefined;
  return () =>
    (pending ??= (async () => {
      let failed = false;
      const report = (operation: string, error: unknown) => {
        failed = true;
        options.report(operation, error);
      };
      try {
        await options.stopRunner();
      } catch (error) {
        report('Stopping scheduler failed', error);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          report('Shutdown deadline exceeded', new Error('Timeout'));
          resolve();
        }, options.timeoutMs ?? 8000);
      });
      const settle = async (operation: string, action: () => Promise<void>) => {
        try {
          await action();
        } catch (error) {
          report(operation, error);
        }
      };
      await Promise.race([
        Promise.all([
          settle('Stopping Channels failed', options.stopPlatform),
          settle('Closing HTTP server failed', options.closeServer),
        ]),
        deadline,
      ]);
      clearTimeout(timer);
      // The state lock is released last, so no request can still be reading
      // from the runtime while another process takes ownership.
      try {
        options.closeState?.();
      } catch (error) {
        report('Closing durable state failed', error);
      }
      options.exit(failed ? 1 : 0);
    })());
}
