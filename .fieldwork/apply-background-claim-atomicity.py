#!/usr/bin/env python3

from __future__ import annotations

import sys
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one exact match, found {count}")
    return text.replace(old, new, 1)


def replace_section(
    text: str,
    start_marker: str,
    end_marker: str,
    replacement: str,
    label: str,
) -> str:
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"{label}: start marker not found")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"{label}: end marker not found")
    return text[:start] + replacement + text[end:]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: apply-background-claim-atomicity.py <source-root>")

    root = Path(sys.argv[1]).resolve()
    lifecycle_path = root / "packages/core/src/services/executionLifecycleService.ts"
    shell_path = root / "packages/core/src/services/shellExecutionService.ts"
    test_path = (
        root
        / "packages/core/src/services/executionLifecycleService.backgroundClaim.test.ts"
    )

    lifecycle = lifecycle_path.read_text()
    lifecycle = replace_once(
        lifecycle,
        "  /** Called synchronously after a background claim is accepted and before result settlement. */\n"
        "  onBackgroundClaim?: () => void;",
        "  /**\n"
        "   * Called synchronously after a background claim is reserved and before result settlement.\n"
        "   * Throwing rejects the claim; re-entrant background attempts are denied.\n"
        "   */\n"
        "  onBackgroundClaim?: () => void;",
        "claim callback contract",
    )
    lifecycle = replace_once(
        lifecycle,
        "  private static backgroundStartListeners = new Set<BackgroundStartListener>();",
        "  private static backgroundStartListeners = new Set<BackgroundStartListener>();\n"
        "  private static backgroundClaims = new Set<number>();",
        "background claim state",
    )
    lifecycle = replace_once(
        lifecycle,
        "    this.backgroundStartListeners.clear();\n"
        "    this.nextExecutionId = NON_PROCESS_EXECUTION_ID_START;",
        "    this.backgroundStartListeners.clear();\n"
        "    this.backgroundClaims.clear();\n"
        "    this.nextExecutionId = NON_PROCESS_EXECUTION_ID_START;",
        "test reset",
    )
    lifecycle = replace_once(
        lifecycle,
        "  static canBackground(executionId: number): boolean {\n"
        "    return (\n"
        "      this.activeResolvers.has(executionId) &&\n"
        "      this.activeExecutions.has(executionId)\n"
        "    );\n"
        "  }",
        "  static canBackground(executionId: number): boolean {\n"
        "    return (\n"
        "      this.activeResolvers.has(executionId) &&\n"
        "      this.activeExecutions.has(executionId) &&\n"
        "      !this.backgroundClaims.has(executionId)\n"
        "    );\n"
        "  }",
        "background eligibility",
    )

    lifecycle_background = """  static background(executionId: number): boolean {
    const resolve = this.activeResolvers.get(executionId);
    if (!resolve) {
      return false;
    }

    const execution = this.activeExecutions.get(executionId);
    if (!execution || this.backgroundClaims.has(executionId)) {
      return false;
    }

    const output = execution.getBackgroundOutput?.() ?? execution.output;

    this.backgroundClaims.add(executionId);
    try {
      execution.onBackgroundClaim?.();
    } catch (error) {
      debugLogger.warn('Background claim callback failed:', error);
      return false;
    } finally {
      this.backgroundClaims.delete(executionId);
    }

    if (
      this.activeResolvers.get(executionId) !== resolve ||
      this.activeExecutions.get(executionId) !== execution
    ) {
      return false;
    }

    resolve({
      rawOutput: Buffer.from(''),
      output,
      exitCode: null,
      signal: null,
      error: null,
      aborted: false,
      pid: executionId,
      executionMethod: execution.executionMethod,
      backgrounded: true,
    });

    this.activeResolvers.delete(executionId);
    execution.backgrounded = true;

    // Notify listeners that an execution was moved to the background.
    const info: BackgroundStartInfo = {
      executionId,
      executionMethod: execution.executionMethod,
      label:
        execution.label ?? `${execution.executionMethod} (ID: ${executionId})`,
      output,
      completionBehavior:
        execution.completionBehavior ??
        (execution.formatInjection ? 'inject' : 'silent'),
    };
    for (const listener of this.backgroundStartListeners) {
      try {
        listener(info);
      } catch (error) {
        debugLogger.warn('Background start listener failed:', error);
      }
    }
    return true;
  }"""
    lifecycle = replace_section(
        lifecycle,
        "  static background(executionId: number): boolean {",
        "\n\n  static subscribe(",
        lifecycle_background,
        "lifecycle background transaction",
    )
    lifecycle_path.write_text(lifecycle)

    shell = shell_path.read_text()
    shell_background = """  static background(
    pid: number,
    sessionId?: string,
    command?: string,
  ): boolean {
    const activePty = this.activePtys.get(pid);
    const activeChild = this.activeChildProcesses.get(pid);

    if (!ExecutionLifecycleService.canBackground(pid)) {
      return false;
    }

    const resolvedSessionId =
      sessionId ?? activePty?.sessionId ?? activeChild?.sessionId;
    const resolvedCommand =
      command ??
      activePty?.command ??
      activeChild?.command ??
      'unknown command';

    if (!resolvedSessionId) {
      throw new Error('Session ID is required for background operations');
    }

    const MAX_BACKGROUND_PROCESS_HISTORY_SIZE = 100;
    const existingHistory =
      this.backgroundProcessHistory.get(resolvedSessionId);
    const historySnapshot = existingHistory
      ? new Map(existingHistory)
      : undefined;
    const history = existingHistory ?? new Map<number, BackgroundProcessRecord>();

    if (history.size >= MAX_BACKGROUND_PROCESS_HISTORY_SIZE) {
      const oldestPid = history.keys().next().value;
      if (oldestPid !== undefined) {
        history.delete(oldestPid);
      }
    }

    history.set(pid, {
      command: resolvedCommand,
      status: 'running',
      startTime: Date.now(),
    });
    this.backgroundProcessHistory.set(resolvedSessionId, history);

    // Set up background logging before lifecycle publication so listeners see
    // one coherent accepted state. Rejected claims restore the prior snapshot.
    const logPath = this.getLogFilePath(pid);
    const logPathExisted = fs.existsSync(logPath);
    const logDir = this.getLogDir();
    try {
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      const stream = fs.createWriteStream(logPath, { flags: 'wx' });
      stream.on('error', (err) => {
        debugLogger.warn('Background log stream error:', err);
      });
      this.backgroundLogStreams.set(pid, stream);

      if (activePty) {
        writeBufferToLogStream(activePty.headlessTerminal, stream, 0);
      } else if (activeChild) {
        const output = activeChild.state.output;
        if (output) {
          stream.write(stripAnsi(output) + '\\n');
        }
      }
    } catch (e) {
      debugLogger.warn('Failed to setup background logging:', e);
    }

    this.backgroundLogPids.add(pid);

    if (ExecutionLifecycleService.background(pid)) {
      return true;
    }

    if (historySnapshot) {
      this.backgroundProcessHistory.set(resolvedSessionId, historySnapshot);
    } else {
      this.backgroundProcessHistory.delete(resolvedSessionId);
    }

    const stream = this.backgroundLogStreams.get(pid);
    this.backgroundLogStreams.delete(pid);
    this.backgroundLogPids.delete(pid);

    const removeNewLog = () => {
      if (logPathExisted) {
        return;
      }
      fs.rm(logPath, { force: true }, (error) => {
        if (error) {
          debugLogger.warn('Failed to remove rejected background log:', error);
        }
      });
    };

    if (stream) {
      stream.end(removeNewLog);
    } else {
      removeNewLog();
    }

    return false;
  }"""
    shell = replace_section(
        shell,
        "  static background(\n    pid: number,",
        "\n\n  static subscribe(",
        shell_background,
        "shell background transaction",
    )
    shell_path.write_text(shell)

    test_path.write_text(
        """/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ExecutionLifecycleService,
  type BackgroundStartInfo,
} from './executionLifecycleService.js';
import { ShellExecutionService } from './shellExecutionService.js';

type BackgroundRecord = {
  command: string;
  status: 'running' | 'exited';
  startTime: number;
};

type ShellExecutionServiceInternals = {
  backgroundLogPids: Set<number>;
  backgroundLogStreams: Map<number, fs.WriteStream>;
  backgroundProcessHistory: Map<string, Map<number, BackgroundRecord>>;
};

const shellInternals =
  ShellExecutionService as unknown as ShellExecutionServiceInternals;

describe('background claim atomicity', () => {
  afterEach(() => {
    ExecutionLifecycleService.resetForTest();
  });

  it('rejects re-entry while one claim is in progress and publishes once', async () => {
    const executionId = 1_900_001;
    const starts: BackgroundStartInfo[] = [];
    let nestedAccepted: boolean | undefined;

    const onBackground = (info: BackgroundStartInfo) => starts.push(info);
    ExecutionLifecycleService.onBackground(onBackground);

    const handle = ExecutionLifecycleService.attachExecution(executionId, {
      executionMethod: 'child_process',
      onBackgroundClaim: () => {
        nestedAccepted = ExecutionLifecycleService.background(executionId);
      },
    });

    expect(ExecutionLifecycleService.background(executionId)).toBe(true);
    expect(nestedAccepted).toBe(false);
    await expect(handle.result).resolves.toMatchObject({
      pid: executionId,
      backgrounded: true,
    });
    expect(starts.map((info) => info.executionId)).toEqual([executionId]);

    ExecutionLifecycleService.offBackground(onBackground);
    ExecutionLifecycleService.completeExecution(executionId, { exitCode: 0 });
  });

  it('rolls back shell publication when a claim callback throws', async () => {
    const executionId = 1_900_002;
    const sessionId = 'fieldwork-background-claim-atomicity';
    const logPath = ShellExecutionService.getLogFilePath(executionId);
    fs.rmSync(logPath, { force: true });

    const handle = ExecutionLifecycleService.attachExecution(executionId, {
      executionMethod: 'child_process',
      onBackgroundClaim: () => {
        throw new Error('synthetic background claim failure');
      },
    });

    expect(
      ShellExecutionService.background(executionId, sessionId, 'sleep 10'),
    ).toBe(false);

    expect(ExecutionLifecycleService.canBackground(executionId)).toBe(true);
    expect(
      shellInternals.backgroundProcessHistory.get(sessionId)?.has(executionId),
    ).not.toBe(true);
    expect(shellInternals.backgroundLogPids.has(executionId)).toBe(false);
    expect(shellInternals.backgroundLogStreams.has(executionId)).toBe(false);
    await vi.waitFor(() => {
      expect(fs.existsSync(logPath)).toBe(false);
    });

    ExecutionLifecycleService.completeExecution(executionId, { exitCode: 0 });
    const foregroundResult = await handle.result;
    expect(foregroundResult.backgrounded).toBeUndefined();
  });

  it('rejects a claim when callback activity settles the execution', async () => {
    const executionId = 1_900_003;
    const starts: BackgroundStartInfo[] = [];
    const onBackground = (info: BackgroundStartInfo) => starts.push(info);
    ExecutionLifecycleService.onBackground(onBackground);

    const handle = ExecutionLifecycleService.attachExecution(executionId, {
      executionMethod: 'child_process',
      onBackgroundClaim: () => {
        ExecutionLifecycleService.completeExecution(executionId, {
          exitCode: 0,
        });
      },
    });

    expect(ExecutionLifecycleService.background(executionId)).toBe(false);
    const result = await handle.result;
    expect(result.exitCode).toBe(0);
    expect(result.backgrounded).toBeUndefined();
    expect(starts).toEqual([]);
    ExecutionLifecycleService.offBackground(onBackground);
  });

  it('isolates a failing start listener after an accepted claim', async () => {
    const executionId = 1_900_004;
    const failingListener = vi.fn(() => {
      throw new Error('synthetic listener failure');
    });
    const successfulListener = vi.fn();
    ExecutionLifecycleService.onBackground(failingListener);
    ExecutionLifecycleService.onBackground(successfulListener);

    const handle = ExecutionLifecycleService.attachExecution(executionId, {
      executionMethod: 'child_process',
    });

    expect(ExecutionLifecycleService.background(executionId)).toBe(true);
    await expect(handle.result).resolves.toMatchObject({ backgrounded: true });
    expect(failingListener).toHaveBeenCalledTimes(1);
    expect(successfulListener).toHaveBeenCalledTimes(1);

    ExecutionLifecycleService.offBackground(failingListener);
    ExecutionLifecycleService.offBackground(successfulListener);
    ExecutionLifecycleService.completeExecution(executionId, { exitCode: 0 });
  });
});
"""
    )


if __name__ == "__main__":
    main()
