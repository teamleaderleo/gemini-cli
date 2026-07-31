#!/usr/bin/env python3

from __future__ import annotations

import sys
from pathlib import Path


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
        raise SystemExit(
            "usage: repair-background-log-publication-order.py <source-root>"
        )

    root = Path(sys.argv[1]).resolve()
    shell_path = root / "packages/core/src/services/shellExecutionService.ts"
    test_path = (
        root
        / "packages/core/src/services/executionLifecycleService.backgroundClaim.test.ts"
    )

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

    if (!ExecutionLifecycleService.background(pid)) {
      if (historySnapshot) {
        this.backgroundProcessHistory.set(resolvedSessionId, historySnapshot);
      } else {
        this.backgroundProcessHistory.delete(resolvedSessionId);
      }
      return false;
    }

    // The lifecycle claim has settled synchronously. Set up logging before the
    // foreground promise continuation runs, without leaving rejected-attempt
    // streams or files that can race an immediate retry.
    const logPath = this.getLogFilePath(pid);
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
    return true;
  }"""
    shell = replace_section(
        shell,
        "  static background(\n    pid: number,",
        "\n\n  static subscribe(",
        shell_background,
        "shell background publication order",
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

async function clearBackgroundPublication(
  pid: number,
  sessionId: string,
): Promise<void> {
  const stream = shellInternals.backgroundLogStreams.get(pid);
  if (stream) {
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
    shellInternals.backgroundLogStreams.delete(pid);
  }

  shellInternals.backgroundLogPids.delete(pid);
  const history = shellInternals.backgroundProcessHistory.get(sessionId);
  history?.delete(pid);
  if (history?.size === 0) {
    shellInternals.backgroundProcessHistory.delete(sessionId);
  }
  fs.rmSync(ShellExecutionService.getLogFilePath(pid), { force: true });
}

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

  it('rolls back rejected history and allows an immediate clean retry', async () => {
    const executionId = 1_900_002;
    const sessionId = 'fieldwork-background-claim-atomicity';
    const logPath = ShellExecutionService.getLogFilePath(executionId);
    fs.rmSync(logPath, { force: true });
    let claimAttempts = 0;

    const handle = ExecutionLifecycleService.attachExecution(executionId, {
      executionMethod: 'child_process',
      onBackgroundClaim: () => {
        claimAttempts += 1;
        if (claimAttempts === 1) {
          throw new Error('synthetic background claim failure');
        }
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
    expect(fs.existsSync(logPath)).toBe(false);

    expect(
      ShellExecutionService.background(executionId, sessionId, 'sleep 10'),
    ).toBe(true);
    expect(claimAttempts).toBe(2);
    await expect(handle.result).resolves.toMatchObject({
      pid: executionId,
      backgrounded: true,
    });
    expect(
      shellInternals.backgroundProcessHistory.get(sessionId)?.get(executionId),
    ).toMatchObject({ command: 'sleep 10', status: 'running' });
    expect(shellInternals.backgroundLogPids.has(executionId)).toBe(true);
    expect(shellInternals.backgroundLogStreams.has(executionId)).toBe(true);

    await clearBackgroundPublication(executionId, sessionId);
    ExecutionLifecycleService.completeExecution(executionId, { exitCode: 0 });
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
