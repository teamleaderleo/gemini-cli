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
import {
  ToolConfirmationOutcome,
  type AnyDeclarativeTool,
  type AnyToolInvocation,
} from '../tools/tools.js';
import { resolveConfirmation } from './confirmation.js';
import type { SchedulerStateManager } from './state-manager.js';
import type { ToolModificationHandler } from './tool-modifier.js';
import {
  CoreToolCallStatus,
  ROOT_SCHEDULER_ID,
  type ValidatingToolCall,
  type WaitingToolCall,
} from './types.js';

describe('inline confirmation modification call affinity', () => {
  it('passes the correlated call to inline modification when approvals overlap', async () => {
    const messageBus = new EventEmitter() as unknown as MessageBus;
    messageBus.publish = vi.fn().mockResolvedValue(undefined);

    const targetInvocation = {
      shouldConfirmExecute: vi.fn().mockResolvedValue({
        type: 'info' as const,
        title: 'Target approval',
        prompt: 'Approve target?',
        onConfirm: vi.fn(),
      }),
    } as unknown as Mocked<AnyToolInvocation>;
    const rebuiltInvocation = {
      getDescription: vi.fn().mockReturnValue('rebuilt target'),
    } as unknown as AnyToolInvocation;
    const targetTool = {
      build: vi.fn().mockReturnValue(rebuiltInvocation),
    } as unknown as Mocked<AnyDeclarativeTool>;

    const targetValidatingCall = {
      status: CoreToolCallStatus.Validating,
      request: {
        callId: 'call-b',
        name: 'target-tool',
        args: { path: 'b.txt' },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
      invocation: targetInvocation,
      tool: targetTool,
    } as ValidatingToolCall;

    const otherWaitingCall = {
      status: CoreToolCallStatus.AwaitingApproval,
      request: {
        callId: 'call-a',
        name: 'other-tool',
        args: { path: 'a.txt' },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
      invocation: {} as AnyToolInvocation,
      tool: {} as AnyDeclarativeTool,
      confirmationDetails: {
        type: 'info' as const,
        title: 'Other approval',
        prompt: 'Approve other?',
      },
      correlationId: 'other-correlation',
    } as WaitingToolCall;

    let currentTargetCall: ValidatingToolCall | WaitingToolCall =
      targetValidatingCall;
    let targetCorrelationId: string | undefined;
    const getToolCall = vi.fn((callId: string) => {
      if (callId === targetValidatingCall.request.callId) {
        return currentTargetCall;
      }
      if (callId === otherWaitingCall.request.callId) {
        return otherWaitingCall;
      }
      return undefined;
    });
    const updateStatus = vi.fn(
      (
        callId: string,
        status: CoreToolCallStatus,
        data?: {
          confirmationDetails?: WaitingToolCall['confirmationDetails'];
          correlationId?: string;
        },
      ) => {
        if (
          callId === targetValidatingCall.request.callId &&
          status === CoreToolCallStatus.AwaitingApproval
        ) {
          targetCorrelationId = data?.correlationId;
          currentTargetCall = {
            ...targetValidatingCall,
            status: CoreToolCallStatus.AwaitingApproval,
            confirmationDetails: data?.confirmationDetails ?? {
              type: 'info',
              title: 'Target approval',
              prompt: 'Approve target?',
            },
            correlationId: targetCorrelationId,
          };
        }
      },
    );
    const state = {
      getToolCall,
      updateStatus,
      updateArgs: vi.fn(),
      firstActiveCall: otherWaitingCall,
    } as unknown as Mocked<SchedulerStateManager>;

    const modifier = {
      applyInlineModify: vi.fn().mockResolvedValue({
        updatedParams: { path: 'b-modified.txt' },
      }),
      handleModifyWithEditor: vi.fn(),
    } as unknown as Mocked<ToolModificationHandler>;
    const config = {
      getHookSystem: vi.fn().mockReturnValue(undefined),
    } as unknown as Mocked<Config>;
    const signal = new AbortController().signal;
    const payload = { newContent: 'modified target content' };

    const resolution = resolveConfirmation(targetValidatingCall, signal, {
      config,
      messageBus,
      state,
      modifier,
      getPreferredEditor: () => undefined,
      schedulerId: ROOT_SCHEDULER_ID,
    });

    await vi.waitFor(() => {
      expect(
        messageBus.listenerCount(MessageBusType.TOOL_CONFIRMATION_RESPONSE),
      ).toBeGreaterThan(0);
      expect(targetCorrelationId).toBeDefined();
    });

    messageBus.emit(MessageBusType.TOOL_CONFIRMATION_RESPONSE, {
      type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      correlationId: targetCorrelationId,
      outcome: ToolConfirmationOutcome.ProceedOnce,
      payload,
    });

    await resolution;

    expect(getToolCall).toHaveBeenCalledWith('call-b');
    expect(getToolCall).not.toHaveBeenCalledWith('call-a');
    expect(modifier.applyInlineModify).toHaveBeenCalledTimes(1);
    const modifiedCall = modifier.applyInlineModify.mock.calls[0]?.[0];
    expect(modifiedCall?.request.callId).toBe('call-b');
    expect(modifiedCall?.request.args).toEqual({ path: 'b.txt' });
    expect(state.updateArgs).toHaveBeenCalledWith(
      'call-b',
      { path: 'b-modified.txt' },
      rebuiltInvocation,
    );
  });
});
