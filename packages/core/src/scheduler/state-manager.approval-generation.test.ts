/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import type { MessageBus } from '../confirmation-bus/message-bus.js';
import type { AnyDeclarativeTool, AnyToolInvocation } from '../tools/tools.js';
import { SchedulerStateManager } from './state-manager.js';
import { CoreToolCallStatus, type ValidatingToolCall } from './types.js';

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

    state.updateStatus(
      call.request.callId,
      CoreToolCallStatus.AwaitingApproval,
      {
        correlationId: 'approval-1',
        confirmationDetails: {
          type: 'info',
          title: 'First approval',
          prompt: 'Approve first generation?',
        },
      },
    );
    const firstWaiting = state.getToolCall(call.request.callId);
    expect(firstWaiting).toMatchObject({
      status: CoreToolCallStatus.AwaitingApproval,
      approvalGeneration: 1,
    });

    state.updateStatus(call.request.callId, CoreToolCallStatus.Validating);
    state.updateStatus(
      call.request.callId,
      CoreToolCallStatus.AwaitingApproval,
      {
        correlationId: 'approval-2',
        confirmationDetails: {
          type: 'info',
          title: 'Second approval',
          prompt: 'Approve second generation?',
        },
      },
    );
    const secondWaiting = state.getToolCall(call.request.callId);
    expect(secondWaiting).toMatchObject({
      status: CoreToolCallStatus.AwaitingApproval,
      approvalGeneration: 2,
    });
  });

  it('does not reuse a generation after a call is finalized', () => {
    const messageBus = {
      publish: vi.fn().mockResolvedValue(undefined),
    } as unknown as MessageBus;
    const state = new SchedulerStateManager(messageBus);
    const firstCall = makeValidatingCall();

    state.enqueue([firstCall]);
    state.dequeue();
    state.updateStatus(
      firstCall.request.callId,
      CoreToolCallStatus.AwaitingApproval,
      {
        correlationId: 'approval-1',
        confirmationDetails: {
          type: 'info',
          title: 'First approval',
          prompt: 'Approve first lifetime?',
        },
      },
    );
    state.updateStatus(
      firstCall.request.callId,
      CoreToolCallStatus.Cancelled,
      'finished',
    );
    state.finalizeCall(firstCall.request.callId);

    const reusedCall = makeValidatingCall();
    state.enqueue([reusedCall]);
    state.dequeue();
    state.updateStatus(
      reusedCall.request.callId,
      CoreToolCallStatus.AwaitingApproval,
      {
        correlationId: 'approval-reused',
        confirmationDetails: {
          type: 'info',
          title: 'Reused approval',
          prompt: 'Approve reused call ID?',
        },
      },
    );

    expect(state.getToolCall(reusedCall.request.callId)).toMatchObject({
      status: CoreToolCallStatus.AwaitingApproval,
      approvalGeneration: 2,
    });
  });

  it('does not reuse a generation when ownership transfers to a tail call', () => {
    const messageBus = {
      publish: vi.fn().mockResolvedValue(undefined),
    } as unknown as MessageBus;
    const state = new SchedulerStateManager(messageBus);
    const firstCall = makeValidatingCall();

    state.enqueue([firstCall]);
    state.dequeue();
    state.updateStatus(
      firstCall.request.callId,
      CoreToolCallStatus.AwaitingApproval,
      {
        correlationId: 'approval-1',
        confirmationDetails: {
          type: 'info',
          title: 'First approval',
          prompt: 'Approve first owner?',
        },
      },
    );

    const tailCall = makeValidatingCall();
    state.replaceActiveCallWithTailCall(firstCall.request.callId, tailCall);
    state.dequeue();
    state.updateStatus(
      tailCall.request.callId,
      CoreToolCallStatus.AwaitingApproval,
      {
        correlationId: 'approval-tail',
        confirmationDetails: {
          type: 'info',
          title: 'Tail approval',
          prompt: 'Approve replacement owner?',
        },
      },
    );

    expect(state.getToolCall(tailCall.request.callId)).toMatchObject({
      status: CoreToolCallStatus.AwaitingApproval,
      approvalGeneration: 2,
    });
  });
});
