/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

import type { Config } from '../config/config.js';
import type { MessageBus } from '../confirmation-bus/message-bus.js';
import { MessageBusType } from '../confirmation-bus/types.js';
import {
  ToolConfirmationOutcome,
  type AnyDeclarativeTool,
  type AnyToolInvocation,
  type ToolCallConfirmationDetails,
} from '../tools/tools.js';
import { resolveConfirmation } from './confirmation.js';
import type { SchedulerStateManager } from './state-manager.js';
import type {
  ModificationResult,
  ToolModificationHandler,
} from './tool-modifier.js';
import {
  CoreToolCallStatus,
  ROOT_SCHEDULER_ID,
  type ValidatingToolCall,
  type WaitingToolCall,
} from './types.js';

const { resolveEditorAsyncMock } = vi.hoisted(() => ({
  resolveEditorAsyncMock: vi.fn(),
}));

vi.mock('../utils/editor.js', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/editor.js')>(
      '../utils/editor.js',
    );
  return {
    ...actual,
    resolveEditorAsync: resolveEditorAsyncMock,
  };
});

interface Harness {
  advanceTargetApprovalGeneration: () => void;
  config: Mocked<Config>;
  getToolCall: ReturnType<typeof vi.fn>;
  messageBus: MessageBus;
  modifier: Mocked<ToolModificationHandler>;
  rebuiltInvocation: AnyToolInvocation;
  setTargetAvailable: (available: boolean) => void;
  setTargetWaiting: (waiting: boolean) => void;
  state: Mocked<SchedulerStateManager>;
  targetCall: ValidatingToolCall;
  targetCorrelationId: () => string | undefined;
}

function makeHarness(
  confirmationResults: Array<ToolCallConfirmationDetails | false | undefined>,
): Harness {
  const messageBus = new EventEmitter() as unknown as MessageBus;
  messageBus.publish = vi.fn().mockResolvedValue(undefined);

  const shouldConfirmExecute = vi.fn();
  for (const result of confirmationResults) {
    shouldConfirmExecute.mockResolvedValueOnce(result);
  }

  const targetInvocation = {
    shouldConfirmExecute,
  } as unknown as Mocked<AnyToolInvocation>;
  const rebuiltInvocation = {
    getDescription: vi.fn().mockReturnValue('rebuilt target'),
  } as unknown as AnyToolInvocation;
  const targetTool = {
    build: vi.fn().mockReturnValue(rebuiltInvocation),
  } as unknown as Mocked<AnyDeclarativeTool>;

  const targetCall = {
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
    approvalGeneration: 1,
    confirmationDetails: {
      type: 'info' as const,
      title: 'Other approval',
      prompt: 'Approve other?',
    },
    correlationId: 'other-correlation',
  } as WaitingToolCall;

  let currentTargetCall: ValidatingToolCall | WaitingToolCall = targetCall;
  let targetAvailable = true;
  let correlationId: string | undefined;
  let approvalGeneration = 0;

  const getToolCall = vi.fn((callId: string) => {
    if (callId === targetCall.request.callId) {
      return targetAvailable ? currentTargetCall : undefined;
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
        callId === targetCall.request.callId &&
        status === CoreToolCallStatus.AwaitingApproval
      ) {
        approvalGeneration += 1;
        correlationId = data?.correlationId;
        currentTargetCall = {
          ...targetCall,
          status: CoreToolCallStatus.AwaitingApproval,
          approvalGeneration,
          confirmationDetails: data?.confirmationDetails ?? {
            type: 'info',
            title: 'Target approval',
            prompt: 'Approve target?',
          },
          correlationId,
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
      updatedParams: { path: 'b-inline.txt' },
    }),
    handleModifyWithEditor: vi.fn().mockResolvedValue({
      updatedParams: { path: 'b-editor.txt' },
    }),
  } as unknown as Mocked<ToolModificationHandler>;

  const config = {
    getHookSystem: vi.fn().mockReturnValue(undefined),
  } as unknown as Mocked<Config>;

  return {
    advanceTargetApprovalGeneration: () => {
      if (currentTargetCall.status !== CoreToolCallStatus.AwaitingApproval) {
        throw new Error('target call is not awaiting approval');
      }
      approvalGeneration += 1;
      currentTargetCall.approvalGeneration = approvalGeneration;
    },
    config,
    getToolCall,
    messageBus,
    modifier,
    rebuiltInvocation,
    setTargetAvailable: (available) => {
      targetAvailable = available;
    },
    setTargetWaiting: (waiting) => {
      if (!waiting) {
        currentTargetCall = targetCall;
      }
    },
    state,
    targetCall,
    targetCorrelationId: () => correlationId,
  };
}

function deferredModification(): {
  promise: Promise<ModificationResult | undefined>;
  resolve: (result: ModificationResult | undefined) => void;
} {
  let resolve!: (result: ModificationResult | undefined) => void;
  const promise = new Promise<ModificationResult | undefined>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitForConfirmationListener(harness: Harness): Promise<void> {
  await vi.waitFor(() => {
    expect(
      harness.messageBus.listenerCount(
        MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      ),
    ).toBeGreaterThan(0);
    expect(harness.targetCorrelationId()).toBeDefined();
  });
}

function emitResponse(
  harness: Harness,
  outcome: ToolConfirmationOutcome,
  payload?: { newContent: string },
): void {
  harness.messageBus.emit(MessageBusType.TOOL_CONFIRMATION_RESPONSE, {
    type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
    correlationId: harness.targetCorrelationId(),
    outcome,
    payload,
  });
}

function resolve(harness: Harness) {
  return resolveConfirmation(harness.targetCall, new AbortController().signal, {
    config: harness.config,
    messageBus: harness.messageBus,
    state: harness.state,
    modifier: harness.modifier,
    getPreferredEditor: () => 'vim',
    schedulerId: ROOT_SCHEDULER_ID,
  });
}

describe('confirmation modification call affinity repair', () => {
  beforeEach(() => {
    resolveEditorAsyncMock.mockReset();
    resolveEditorAsyncMock.mockResolvedValue('vim');
  });

  it('passes the exact correlated waiting call to inline modification', async () => {
    const harness = makeHarness([
      {
        type: 'info',
        title: 'Target approval',
        prompt: 'Approve target?',
        onConfirm: vi.fn(),
      },
    ]);

    const resolution = resolve(harness);
    await waitForConfirmationListener(harness);
    emitResponse(harness, ToolConfirmationOutcome.ProceedOnce, {
      newContent: 'modified target content',
    });
    await resolution;

    expect(harness.getToolCall).toHaveBeenCalledWith('call-b');
    expect(harness.modifier.applyInlineModify).toHaveBeenCalledTimes(1);
    const modifiedCall = harness.modifier.applyInlineModify.mock.calls[0]?.[0];
    expect(modifiedCall?.request.callId).toBe('call-b');
    expect(modifiedCall?.request.args).toEqual({ path: 'b.txt' });
    expect(harness.state.updateArgs).toHaveBeenCalledWith(
      'call-b',
      { path: 'b-inline.txt' },
      harness.rebuiltInvocation,
    );
  });

  it('passes the exact correlated waiting call to editor modification', async () => {
    const harness = makeHarness([
      {
        type: 'info',
        title: 'Target approval',
        prompt: 'Approve target?',
        onConfirm: vi.fn(),
      },
      undefined,
    ]);

    const resolution = resolve(harness);
    await waitForConfirmationListener(harness);
    emitResponse(harness, ToolConfirmationOutcome.ModifyWithEditor);
    await resolution;

    expect(resolveEditorAsyncMock).toHaveBeenCalledWith(
      'vim',
      expect.anything(),
    );
    expect(harness.modifier.handleModifyWithEditor).toHaveBeenCalledTimes(1);
    const modifiedCall =
      harness.modifier.handleModifyWithEditor.mock.calls[0]?.[0];
    expect(modifiedCall?.request.callId).toBe('call-b');
    expect(modifiedCall?.request.args).toEqual({ path: 'b.txt' });
    expect(harness.state.updateArgs).toHaveBeenCalledWith(
      'call-b',
      { path: 'b-editor.txt' },
      harness.rebuiltInvocation,
    );
  });

  it('rejects an inline update when the call is removed during modification', async () => {
    const harness = makeHarness([
      {
        type: 'info',
        title: 'Target approval',
        prompt: 'Approve target?',
        onConfirm: vi.fn(),
      },
    ]);
    const modification = deferredModification();
    harness.modifier.applyInlineModify.mockReturnValueOnce(
      modification.promise,
    );

    const resolution = resolve(harness);
    await waitForConfirmationListener(harness);
    emitResponse(harness, ToolConfirmationOutcome.ProceedOnce, {
      newContent: 'modified target content',
    });
    await vi.waitFor(() => {
      expect(harness.modifier.applyInlineModify).toHaveBeenCalledTimes(1);
    });

    harness.setTargetAvailable(false);
    modification.resolve({ updatedParams: { path: 'stale-inline.txt' } });

    await expect(resolution).rejects.toThrow(
      'Tool call call-b is no longer awaiting approval during modification',
    );
    expect(harness.state.updateArgs).not.toHaveBeenCalled();
  });

  it('rejects an editor update when the call leaves approval during modification', async () => {
    const harness = makeHarness([
      {
        type: 'info',
        title: 'Target approval',
        prompt: 'Approve target?',
        onConfirm: vi.fn(),
      },
      undefined,
    ]);
    const modification = deferredModification();
    harness.modifier.handleModifyWithEditor.mockReturnValueOnce(
      modification.promise,
    );

    const resolution = resolve(harness);
    await waitForConfirmationListener(harness);
    emitResponse(harness, ToolConfirmationOutcome.ModifyWithEditor);
    await vi.waitFor(() => {
      expect(harness.modifier.handleModifyWithEditor).toHaveBeenCalledTimes(1);
    });

    harness.setTargetWaiting(false);
    modification.resolve({ updatedParams: { path: 'stale-editor.txt' } });

    await expect(resolution).rejects.toThrow(
      'Tool call call-b is no longer awaiting approval during modification',
    );
    expect(harness.state.updateArgs).not.toHaveBeenCalled();
  });

  it('rejects an update after the same wrapper enters a new approval generation', async () => {
    const harness = makeHarness([
      {
        type: 'info',
        title: 'Target approval',
        prompt: 'Approve target?',
        onConfirm: vi.fn(),
      },
    ]);
    const modification = deferredModification();
    harness.modifier.applyInlineModify.mockReturnValueOnce(
      modification.promise,
    );

    const resolution = resolve(harness);
    await waitForConfirmationListener(harness);
    emitResponse(harness, ToolConfirmationOutcome.ProceedOnce, {
      newContent: 'modified target content',
    });
    await vi.waitFor(() => {
      expect(harness.modifier.applyInlineModify).toHaveBeenCalledTimes(1);
    });

    harness.advanceTargetApprovalGeneration();
    modification.resolve({ updatedParams: { path: 'stale-generation.txt' } });

    await expect(resolution).rejects.toThrow(
      'Tool call call-b entered a new approval generation during modification',
    );
    expect(harness.state.updateArgs).not.toHaveBeenCalled();
  });

  it('fails closed when the correlated call is lost before modification', async () => {
    const harness = makeHarness([
      {
        type: 'info',
        title: 'Target approval',
        prompt: 'Approve target?',
        onConfirm: vi.fn(),
      },
    ]);

    const resolution = resolve(harness);
    await waitForConfirmationListener(harness);
    harness.setTargetAvailable(false);
    emitResponse(harness, ToolConfirmationOutcome.ProceedOnce, {
      newContent: 'must not target another call',
    });

    await expect(resolution).rejects.toThrow(
      'Tool call call-b is no longer awaiting approval during modification',
    );
    expect(harness.modifier.applyInlineModify).not.toHaveBeenCalled();
    expect(harness.modifier.handleModifyWithEditor).not.toHaveBeenCalled();
    expect(harness.state.updateArgs).not.toHaveBeenCalled();
  });

  it('rejects an inline response when onConfirm replaces the approval generation', async () => {
    const harnessRef: { current?: Harness } = {};
    const onConfirm = vi.fn(async () => {
      if (!harnessRef.current) throw new Error('missing test harness');
      harnessRef.current.advanceTargetApprovalGeneration();
    });
    const harness = makeHarness([
      {
        type: 'info',
        title: 'Target approval',
        prompt: 'Approve target?',
        onConfirm,
      },
    ]);
    harnessRef.current = harness;

    const resolution = resolve(harness);
    await waitForConfirmationListener(harness);
    emitResponse(harness, ToolConfirmationOutcome.ProceedOnce, {
      newContent: 'stale inline response',
    });

    await expect(resolution).rejects.toThrow(
      'Tool call call-b entered a new approval generation during modification',
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(harness.modifier.applyInlineModify).not.toHaveBeenCalled();
    expect(harness.state.updateArgs).not.toHaveBeenCalled();
  });

  it('rejects an editor response when the generation changes during editor resolution', async () => {
    let resolveEditor!: (editor: 'vim') => void;
    const editorPromise = new Promise<'vim'>((resolve) => {
      resolveEditor = resolve;
    });
    resolveEditorAsyncMock.mockReturnValueOnce(editorPromise);

    const harness = makeHarness([
      {
        type: 'info',
        title: 'Target approval',
        prompt: 'Approve target?',
        onConfirm: vi.fn(),
      },
      undefined,
    ]);

    const resolution = resolve(harness);
    await waitForConfirmationListener(harness);
    emitResponse(harness, ToolConfirmationOutcome.ModifyWithEditor);
    await vi.waitFor(() => {
      expect(resolveEditorAsyncMock).toHaveBeenCalledTimes(1);
    });

    harness.advanceTargetApprovalGeneration();
    resolveEditor('vim');

    await expect(resolution).rejects.toThrow(
      'Tool call call-b entered a new approval generation during modification',
    );
    expect(harness.modifier.handleModifyWithEditor).not.toHaveBeenCalled();
    expect(harness.state.updateArgs).not.toHaveBeenCalled();
  });
});
