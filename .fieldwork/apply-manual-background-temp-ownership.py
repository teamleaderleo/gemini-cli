#!/usr/bin/env python3
"""Apply the bounded manual foreground-to-background temp ownership repair."""

from __future__ import annotations

from pathlib import Path
import sys


def replace_exact(path: Path, old: str, new: str, expected: int = 1) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != expected:
        raise SystemExit(
            f"{path}: expected {expected} occurrence(s), found {count}: {old[:80]!r}"
        )
    path.write_text(text.replace(old, new), encoding="utf-8")


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: apply-manual-background-temp-ownership.py SOURCE_ROOT")

    root = Path(sys.argv[1]).resolve()
    lifecycle = root / "packages/core/src/services/executionLifecycleService.ts"
    service = root / "packages/core/src/services/shellExecutionService.ts"
    shell = root / "packages/core/src/tools/shell.ts"
    shell_test = (
        root
        / "packages/core/src/tools/shell-background-temp-ownership-repair.test.ts"
    )
    service_test = (
        root
        / "packages/core/src/services/shell-execution-process-exit-cleanup.test.ts"
    )

    replace_exact(
        lifecycle,
        """  isActive?: () => boolean;
  formatInjection?: FormatInjectionFn;
""",
        """  isActive?: () => boolean;
  /** Called synchronously after a background claim is accepted and before result settlement. */
  onBackgroundClaim?: () => void;
  formatInjection?: FormatInjectionFn;
""",
    )
    replace_exact(
        lifecycle,
        """  backgrounded?: boolean;
  formatInjection?: FormatInjectionFn;
""",
        """  backgrounded?: boolean;
  onBackgroundClaim?: () => void;
  formatInjection?: FormatInjectionFn;
""",
    )
    replace_exact(
        lifecycle,
        """      isActive: registration.isActive,
      formatInjection: registration.formatInjection,
""",
        """      isActive: registration.isActive,
      onBackgroundClaim: registration.onBackgroundClaim,
      formatInjection: registration.formatInjection,
""",
    )
    replace_exact(
        lifecycle,
        """    const output = execution.getBackgroundOutput?.() ?? execution.output;

    resolve({
      rawOutput: Buffer.from(''),
""",
        """    const output = execution.getBackgroundOutput?.() ?? execution.output;

    execution.onBackgroundClaim?.();

    resolve({
      rawOutput: Buffer.from(''),
""",
    )

    replace_exact(
        service,
        """  /** Best-effort cleanup for resources that remain owned until actual exit. */
  onProcessExit?: () => void | Promise<void>;
  env?: Record<string, string>;
""",
        """  /** Synchronous ownership transfer before a foreground result settles as backgrounded. */
  onBackgroundClaim?: () => void;
  /** Best-effort cleanup for resources that remain owned until actual exit. */
  onProcessExit?: () => void | Promise<void>;
  env?: Record<string, string>;
""",
    )
    replace_exact(
        service,
        """        completionBehavior:
          shellExecutionConfig.backgroundCompletionBehavior || 'silent',
""",
        """        onBackgroundClaim: shellExecutionConfig.onBackgroundClaim,
        completionBehavior:
          shellExecutionConfig.backgroundCompletionBehavior || 'silent',
""",
        expected=2,
    )

    replace_exact(
        shell,
        """    const cleanupAfterTransferredExit = async (): Promise<void> => {
      processExitObserved = true;
      if (tempCleanupTransferred) {
        await cleanupTemporaryResources();
      }
    };

    const timeoutMs = this.context.config.getShellToolInactivityTimeout();
""",
        """    const cleanupAfterTransferredExit = async (): Promise<void> => {
      processExitObserved = true;
      if (tempCleanupTransferred) {
        await cleanupTemporaryResources();
      }
    };

    const claimTemporaryResourceTransfer = (): void => {
      tempCleanupTransferred = true;
      if (processExitObserved) {
        void cleanupTemporaryResources();
      }
    };

    const timeoutMs = this.context.config.getShellToolInactivityTimeout();
""",
    )
    replace_exact(
        shell,
        """            onProcessExit: this.params.is_background
              ? cleanupAfterTransferredExit
              : undefined,
""",
        """            onBackgroundClaim: claimTemporaryResourceTransfer,
            onProcessExit: cleanupAfterTransferredExit,
""",
    )
    replace_exact(
        shell,
        """          setTimeout(() => {
            tempCleanupTransferred = ShellExecutionService.background(
              pid,
              sessionId,
              strippedCommand,
            );
            if (tempCleanupTransferred && processExitObserved) {
              void cleanupTemporaryResources();
            }
          }, delay);
""",
        """          setTimeout(() => {
            ShellExecutionService.background(pid, sessionId, strippedCommand);
          }, delay);
""",
    )

    replace_exact(
        shell_test,
        """  let resolveExecution: (result: ShellExecutionResult) => void;
  let processExitCleanup: ShellExecutionConfig['onProcessExit'];
""",
        """  let resolveExecution: (result: ShellExecutionResult) => void;
  let backgroundClaim: ShellExecutionConfig['onBackgroundClaim'];
  let processExitCleanup: ShellExecutionConfig['onProcessExit'];
""",
    )
    replace_exact(
        shell_test,
        """    extractedTempFile = undefined;
    processExitCleanup = undefined;
    backgroundMock.mockReturnValue(false);
""",
        """    extractedTempFile = undefined;
    backgroundClaim = undefined;
    processExitCleanup = undefined;
    backgroundMock.mockReturnValue(false);
""",
    )
    replace_exact(
        shell_test,
        """        extractedTempFile = match?.[1].replace(/['\"]/g, '');
        processExitCleanup = shellExecutionConfig.onProcessExit;
""",
        """        extractedTempFile = match?.[1].replace(/['\"]/g, '');
        backgroundClaim = shellExecutionConfig.onBackgroundClaim;
        processExitCleanup = shellExecutionConfig.onProcessExit;
""",
    )
    replace_exact(
        shell_test,
        """    backgroundMock.mockImplementation(() => {
      resolveExecution(
""",
        """    backgroundMock.mockImplementation(() => {
      backgroundClaim?.();
      resolveExecution(
""",
    )
    replace_exact(
        shell_test,
        """  it('keeps foreground cleanup creator-owned', async () => {
""",
        """  it('transfers foreground cleanup before manual background settlement', async () => {
    const invocation = shellTool.build({ command: 'sleep 10' });
    const execution = invocation.execute({
      abortSignal: new AbortController().signal,
    });

    await vi.waitFor(() => {
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(extractedTempFile).toBeDefined();
      expect(backgroundClaim).toBeTypeOf('function');
      expect(processExitCleanup).toBeTypeOf('function');
    });

    backgroundClaim?.();
    expect(fs.existsSync(path.dirname(extractedTempFile!))).toBe(true);

    resolveExecution(
      completedResult({
        exitCode: null,
        backgrounded: true,
      }),
    );
    await execution;

    expect(fs.existsSync(path.dirname(extractedTempFile!))).toBe(true);
    await processExitCleanup?.();
    expect(fs.existsSync(path.dirname(extractedTempFile!))).toBe(false);
  });

  it('keeps foreground cleanup creator-owned', async () => {
""",
    )
    replace_exact(
        shell_test,
        """    expect(processExitCleanup).toBeUndefined();
    resolveExecution(completedResult());
""",
        """    expect(backgroundClaim).toBeTypeOf('function');
    expect(processExitCleanup).toBeTypeOf('function');
    resolveExecution(completedResult());
""",
    )

    replace_exact(
        service_test,
        """  it('invokes transferred cleanup after child-process exit', async () => {
""",
        """  it('runs a manual background claim before the foreground result settles', async () => {
    const events: string[] = [];
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const handle = await ShellExecutionService.execute(
      'exec sleep 10',
      process.cwd(),
      vi.fn(),
      new AbortController().signal,
      false,
      {
        sanitizationConfig,
        sandboxManager: new NoopSandboxManager(),
        sessionId: 'fieldwork-manual-background-claim',
        onBackgroundClaim: () => events.push('claim'),
        onProcessExit: cleanup,
      },
    );

    expect(handle.pid).toBeTypeOf('number');
    const child = activeChildProcess(handle.pid!);
    expect(child).toBeDefined();

    void handle.result.then(() => events.push('resolved'));
    expect(
      ShellExecutionService.background(
        handle.pid!,
        'fieldwork-manual-background-claim',
        'sleep 10',
      ),
    ).toBe(true);
    await handle.result;
    expect(events).toEqual(['claim', 'resolved']);

    const closed = new Promise<void>((resolve) => {
      child!.process.once('close', () => resolve());
    });
    expect(child!.process.kill('SIGTERM')).toBe(true);
    await closed;
    await vi.waitFor(() => {
      expect(cleanup).toHaveBeenCalledTimes(1);
    });
  });

  it('invokes transferred cleanup after child-process exit', async () => {
""",
    )

    print("FIELDWORK_MANUAL_BACKGROUND_TRANSFORM=5/5-files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
