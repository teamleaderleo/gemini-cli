/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, type Mocked } from 'vitest';

import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { MessageBusType } from '../confirmation-bus/types.js';
import type {
  AnyDeclarativeTool,
  AnyToolInvocation,
} from '../tools/tools.js';
import { resolveConfirmation } from './confirmation.js';
import type { SchedulerStateManager } from './state-manager.js';
import type { ToolModificationHandler } from './tool-modifier.js';
import {
  CoreToolCallStatus,
  ROOT_SCHEDULER_ID,
  type ValidatingToolCall,
} from './types.js';

describe('confirmation waiting state cleanup', () => {
  it('balances waiting transitions when the approval wait is aborted', async () => {
    const messageBus = new EventEmitter() as unknown as MessageBus;
    messageBus.publish = vi.fn().mockResolvedValue(undefined);

    const invocation = {
      shouldConfirmExecute: vi.fn().mockResolvedValue({
        type: 'info' as const,
        title: 'Approval',
        prompt: 'Approve?',
        onConfirm: vi.fn(),
      }),
    } as unknown as Mocked<AnyToolInvocation>;
    const tool = {
      build: vi.fn(),
    } as unknown as Mocked<AnyDeclarativeTool>;
    const toolCall = {
      status: CoreToolCallStatus.Validating,
      request: {
        callId: 'call-1',
        name: 'tool',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
      invocation,
      tool,
    } as ValidatingToolCall;

    const state = {
      getToolCall: vi.fn().mockReturnValue(toolCall),
      updateStatus: vi.fn(),
      updateArgs: vi.fn(),
    } as unknown as Mocked<SchedulerStateManager>;
    const modifier = {
      applyInlineModify: vi.fn(),
      handleModifyWithEditor: vi.fn(),
    } as unknown as Mocked<ToolModificationHandler>;
    const config = {
      getHookSystem: vi.fn().mockReturnValue(undefined),
    } as unknown as Mocked<Config>;
    const onWaitingForConfirmation = vi.fn();
    const controller = new AbortController();

    const resolution = resolveConfirmation(toolCall, controller.signal, {
      config,
      messageBus,
      state,
      modifier,
      getPreferredEditor: () => undefined,
      schedulerId: ROOT_SCHEDULER_ID,
      onWaitingForConfirmation,
    });

    await vi.waitFor(() => {
      expect(
        messageBus.listenerCount(MessageBusType.TOOL_CONFIRMATION_RESPONSE),
      ).toBeGreaterThan(0);
      expect(onWaitingForConfirmation).toHaveBeenCalledWith(true);
    });

    controller.abort();

    await expect(resolution).rejects.toThrow('Operation cancelled');
    expect(onWaitingForConfirmation.mock.calls.map(([waiting]) => waiting)).toEqual([
      true,
      false,
    ]);
  });
});
