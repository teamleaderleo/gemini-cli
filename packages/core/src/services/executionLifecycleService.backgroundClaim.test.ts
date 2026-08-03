/**
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
