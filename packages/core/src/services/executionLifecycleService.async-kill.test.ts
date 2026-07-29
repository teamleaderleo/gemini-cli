/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ExecutionLifecycleService } from './executionLifecycleService.js';

describe('ExecutionLifecycleService asynchronous kill ownership', () => {
  beforeEach(() => {
    ExecutionLifecycleService.resetForTest();
  });

  it('keeps an external execution active until its asynchronous kill hook settles', async () => {
    const executionId = 2_000_000_123;
    let releaseTermination: (() => void) | undefined;
    const terminationGate = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    let operatingSystemProcessAlive = true;
    const terminate = vi.fn(async () => {
      await terminationGate;
      operatingSystemProcessAlive = false;
    });

    const handle = ExecutionLifecycleService.attachExecution(executionId, {
      executionMethod: 'child_process',
      initialOutput: 'running',
      kill: terminate,
      isActive: () => operatingSystemProcessAlive,
    });
    let resultSettled = false;
    void handle.result.then(() => {
      resultSettled = true;
    });

    ExecutionLifecycleService.kill(executionId);
    await Promise.resolve();

    expect(terminate).toHaveBeenCalledTimes(1);
    expect(operatingSystemProcessAlive).toBe(true);
    expect(ExecutionLifecycleService.isActive(executionId)).toBe(true);
    expect(resultSettled).toBe(false);

    releaseTermination?.();
    const result = await handle.result;

    expect(operatingSystemProcessAlive).toBe(false);
    expect(ExecutionLifecycleService.isActive(executionId)).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(130);
  });
});
