/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type {
  AnyDeclarativeTool,
  AnyToolInvocation,
} from '../tools/tools.js';
import { SchedulerStateManager } from './state-manager.js';
import {
  CoreToolCallStatus,
  type ValidatingToolCall,
} from './types.js';

function makeValidatingCall(): ValidatingToolCall {
  return {
    status: CoreToolCallStatus.Validating,
    request: {
      callId: 'approval-generation-call',
      name: 'test-tool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    },
    tool: {} as AnyDeclarativeTool,
    invocation: {} as AnyToolInvocation,
  };
}

describe('SchedulerStateManager approval generations', () => {
  it('increments when the same call leaves and re-enters approval', () => {
    const messageBus = {
      publish: vi.fn().mockResolvedValue(undefined),
    } as unknown as MessageBus;
    const state = new SchedulerStateManager(messageBus);
    const call = makeValidatingCall();

    state.enqueue([call]);
    state.dequeue();

    state.updateStatus(call.request.callId, CoreToolCallStatus.AwaitingApproval, {
      correlationId: 'approval-1',
      confirmationDetails: {
        type: 'info',
        title: 'First approval',
        prompt: 'Approve first generation?',
      },
    });
    const firstWaiting = state.getToolCall(call.request.callId);
    expect(firstWaiting).toMatchObject({
      status: CoreToolCallStatus.AwaitingApproval,
      approvalGeneration: 1,
    });

    state.updateStatus(call.request.callId, CoreToolCallStatus.Validating);
    state.updateStatus(call.request.callId, CoreToolCallStatus.AwaitingApproval, {
      correlationId: 'approval-2',
      confirmationDetails: {
        type: 'info',
        title: 'Second approval',
        prompt: 'Approve second generation?',
      },
    });
    const secondWaiting = state.getToolCall(call.request.callId);
    expect(secondWaiting).toMatchObject({
      status: CoreToolCallStatus.AwaitingApproval,
      approvalGeneration: 2,
    });
  });
});
