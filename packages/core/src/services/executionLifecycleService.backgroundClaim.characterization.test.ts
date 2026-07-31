/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

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

describe('background claim atomicity characterization', () => {
  afterEach(() => {
    ExecutionLifecycleService.resetForTest();
  });

  it('currently accepts guarded re-entry twice and emits duplicate starts', async () => {
    const executionId = 1_900_001;
    const starts: BackgroundStartInfo[] = [];
    let entered = false;
    let nestedAccepted: boolean | undefined;

    const onBackground = (info: BackgroundStartInfo) => starts.push(info);
    ExecutionLifecycleService.onBackground(onBackground);

    const handle = ExecutionLifecycleService.attachExecution(executionId, {
      executionMethod: 'child_process',
      onBackgroundClaim: () => {
        if (!entered) {
          entered = true;
          nestedAccepted = ExecutionLifecycleService.background(executionId);
        }
      },
    });

    expect(ExecutionLifecycleService.background(executionId)).toBe(true);
    expect(nestedAccepted).toBe(true);
    await expect(handle.result).resolves.toMatchObject({
      pid: executionId,
      backgrounded: true,
    });
    expect(starts.map((info) => info.executionId)).toEqual([
      executionId,
      executionId,
    ]);

    ExecutionLifecycleService.offBackground(onBackground);
    ExecutionLifecycleService.completeExecution(executionId, { exitCode: 0 });
  });

  it('currently leaves shell publication after a rejected throwing claim', async () => {
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

    expect(() =>
      ShellExecutionService.background(executionId, sessionId, 'sleep 10'),
    ).toThrow('synthetic background claim failure');

    expect(ExecutionLifecycleService.canBackground(executionId)).toBe(true);
    expect(
      shellInternals.backgroundProcessHistory.get(sessionId)?.get(executionId),
    ).toMatchObject({
      command: 'sleep 10',
      status: 'running',
    });
    expect(shellInternals.backgroundLogPids.has(executionId)).toBe(true);

    await clearBackgroundPublication(executionId, sessionId);
    ExecutionLifecycleService.completeExecution(executionId, { exitCode: 0 });
    await expect(handle.result).resolves.toMatchObject({
      pid: executionId,
      backgrounded: undefined,
    });
  });
});
