/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi, type Mocked } from 'vitest';
import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { MessageBusType } from '../confirmation-bus/types.js';
import {
  ToolConfirmationOutcome,
  type AnyDeclarativeTool,
  type AnyToolInvocation,
  type ToolCallConfirmationDetails,
} from '../tools/tools.js';
import { debugLogger } from '../utils/debugLogger.js';
import { resolveConfirmation } from './confirmation.js';
import type { SchedulerStateManager } from './state-manager.js';
import type { ToolModificationHandler } from './tool-modifier.js';
import {
  CoreToolCallStatus,
  ROOT_SCHEDULER_ID,
  type ValidatingToolCall,
} from './types.js';

type ConfirmationDetailsWithIde = ToolCallConfirmationDetails & {
  ideConfirmation?: Promise<never>;
};

function createHarness(details: ConfirmationDetailsWithIde) {
  const messageBus = new EventEmitter() as unknown as MessageBus;
  messageBus.publish = vi.fn().mockResolvedValue(undefined);
  const invocation = {
    shouldConfirmExecute: vi.fn().mockResolvedValue(details),
  } as unknown as Mocked<AnyToolInvocation>;
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
    tool: { build: vi.fn() } as unknown as AnyDeclarativeTool,
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
  return { config, messageBus, modifier, state, toolCall };
}

function resolve(
  harness: ReturnType<typeof createHarness>,
  signal: AbortSignal,
  onWaitingForConfirmation: (waiting: boolean) => void,
) {
  return resolveConfirmation(harness.toolCall, signal, {
    config: harness.config,
    messageBus: harness.messageBus,
    state: harness.state,
    modifier: harness.modifier,
    getPreferredEditor: () => undefined,
    schedulerId: ROOT_SCHEDULER_ID,
    onWaitingForConfirmation,
  });
}

async function waitForBus(harness: ReturnType<typeof createHarness>) {
  await vi.waitFor(() => {
    expect(
      harness.messageBus.listenerCount(
        MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      ),
    ).toBeGreaterThan(0);
  });
}

function confirmationCorrelationId(
  harness: ReturnType<typeof createHarness>,
): string {
  const statusCalls = harness.state.updateStatus.mock.calls as unknown as Array<
    [string, CoreToolCallStatus, { correlationId?: string }?]
  >;
  const statusCall = statusCalls.find(
    ([, status]) => status === CoreToolCallStatus.AwaitingApproval,
  );
  const data = statusCall?.[2] as { correlationId?: string } | undefined;
  expect(data?.correlationId).toBeDefined();
  return data?.correlationId ?? '';
}

describe('confirmation waiting ownership repair', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears waiting state when the message-bus wait is aborted', async () => {
    const harness = createHarness({
      type: 'info',
      title: 'Approval',
      prompt: 'Approve?',
      onConfirm: vi.fn(),
    });
    const onWaiting = vi.fn();
    const controller = new AbortController();
    const resolution = resolve(harness, controller.signal, onWaiting);
    await waitForBus(harness);
    controller.abort();

    await expect(resolution).rejects.toThrow('Operation cancelled');
    expect(onWaiting.mock.calls.map(([waiting]) => waiting)).toEqual([
      true,
      false,
    ]);
  });

  it('keeps waiting on the bus after IDE confirmation rejects', async () => {
    const warn = vi.spyOn(debugLogger, 'warn').mockImplementation(() => {});
    let rejectIde!: (error: Error) => void;
    const ideConfirmation = new Promise<never>((_resolve, reject) => {
      rejectIde = reject;
    });
    const harness = createHarness({
      type: 'info',
      title: 'Approval',
      prompt: 'Approve?',
      onConfirm: vi.fn(),
      ideConfirmation,
    });
    const onWaiting = vi.fn();
    const resolution = resolve(
      harness,
      new AbortController().signal,
      onWaiting,
    );
    await waitForBus(harness);
    rejectIde(new Error('IDE confirmation failed'));

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        'Error waiting for confirmation via IDE',
        expect.objectContaining({ message: 'IDE confirmation failed' }),
      );
    });
    expect(onWaiting.mock.calls.map(([waiting]) => waiting)).toEqual([true]);

    harness.messageBus.emit(MessageBusType.TOOL_CONFIRMATION_RESPONSE, {
      type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      correlationId: confirmationCorrelationId(harness),
      outcome: ToolConfirmationOutcome.Cancel,
    });

    await expect(resolution).resolves.toMatchObject({
      outcome: ToolConfirmationOutcome.Cancel,
    });
    expect(onWaiting.mock.calls.map(([waiting]) => waiting)).toEqual([
      true,
      false,
    ]);
  });

  it('preserves the wait error when clearing state also throws', async () => {
    const warn = vi.spyOn(debugLogger, 'warn').mockImplementation(() => {});
    const harness = createHarness({
      type: 'info',
      title: 'Approval',
      prompt: 'Approve?',
      onConfirm: vi.fn(),
    });
    const onWaiting = vi.fn((waiting: boolean) => {
      if (!waiting) throw new Error('clear observer failed');
    });
    const controller = new AbortController();
    const resolution = resolve(harness, controller.signal, onWaiting);
    await waitForBus(harness);
    controller.abort();

    await expect(resolution).rejects.toThrow('Operation cancelled');
    expect(warn).toHaveBeenCalledWith(
      'Failed to clear confirmation waiting state after wait failure',
      expect.objectContaining({ message: 'clear observer failed' }),
    );
  });

  it('propagates a clear observer error after a successful wait', async () => {
    const harness = createHarness({
      type: 'info',
      title: 'Approval',
      prompt: 'Approve?',
      onConfirm: vi.fn(),
    });
    const onWaiting = vi.fn((waiting: boolean) => {
      if (!waiting) throw new Error('clear observer failed');
    });
    const resolution = resolve(
      harness,
      new AbortController().signal,
      onWaiting,
    );
    await waitForBus(harness);
    harness.messageBus.emit(MessageBusType.TOOL_CONFIRMATION_RESPONSE, {
      type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      correlationId: confirmationCorrelationId(harness),
      outcome: ToolConfirmationOutcome.ProceedOnce,
    });

    await expect(resolution).rejects.toThrow('clear observer failed');
  });
});
