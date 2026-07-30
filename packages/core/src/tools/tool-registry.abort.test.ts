/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { killProcessGroup } from '../utils/process-utils.js';
import { DiscoveredTool } from './tool-registry.js';
import { DISCOVERED_TOOL_PREFIX } from './tool-names.js';

vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>(
      'node:child_process',
    );
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock('../utils/process-utils.js', () => ({
  killProcessGroup: vi.fn().mockResolvedValue(undefined),
}));

class ControlledChildProcess extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  connected = true;
  readonly disconnect = vi.fn(() => {
    this.connected = false;
  });
}

const messageBus = {
  publish: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
} as unknown as MessageBus;

const config = {
  getToolDiscoveryCommand: () => 'discover-tools',
  getToolCallCommand: () => 'call-tool',
  sandboxManager: undefined,
} as unknown as Config;

describe('DiscoveredTool abort handoff', () => {
  it('requests process-tree termination for the spawned child after abort', async () => {
    const child = new ControlledChildProcess();
    vi.mocked(spawn).mockReturnValue(
      child as unknown as ReturnType<typeof spawn>,
    );

    const tool = new DiscoveredTool(
      config,
      'slow-tool',
      `${DISCOVERED_TOOL_PREFIX}slow-tool`,
      'A deterministic long-running discovered tool.',
      { type: 'object', properties: {} },
      messageBus,
    );
    const invocation = tool.build({});
    const controller = new AbortController();
    const execution = invocation.execute({
      abortSignal: controller.signal,
    });

    controller.abort();

    try {
      await vi.waitFor(() => {
        expect(vi.mocked(killProcessGroup)).toHaveBeenCalledWith(
          expect.objectContaining({
            pid: child.pid,
            escalate: true,
          }),
        );
      });
    } finally {
      child.emit('close', null, 'SIGTERM');
      await execution.catch(() => undefined);
    }
  });
});
