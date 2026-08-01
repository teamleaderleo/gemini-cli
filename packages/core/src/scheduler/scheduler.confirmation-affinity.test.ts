/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';

const runInDevTraceSpan = vi.hoisted(() =>
  vi.fn(async (_options, callback) =>
    callback({ metadata: { attributes: {} } }),
  ),
);

vi.mock('../telemetry/trace.js', () => ({ runInDevTraceSpan }));
vi.mock('../telemetry/loggers.js', () => ({ logToolCall: vi.fn() }));
vi.mock('../telemetry/types.js', () => ({
  ToolCallEvent: vi.fn().mockImplementation((call) => call),
}));
vi.mock('./policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./policy.js')>();
  return {
    ...actual,
    checkPolicy: vi.fn(),
    updatePolicy: vi.fn(),
  };
});
vi.mock('./tool-executor.js');
vi.mock('./tool-modifier.js');

import { MessageBus } from '../confirmation-bus/message-bus.js';
import {
  MessageBusType,
  type ToolCallsUpdateMessage,
} from '../confirmation-bus/types.js';
import type { Config } from '../config/config.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { PolicyEngine } from '../policy/policy-engine.js';
import { ApprovalMode, PolicyDecision } from '../policy/types.js';
import {
  ToolConfirmationOutcome,
  type AnyDeclarativeTool,
} from '../tools/tools.js';
import { checkPolicy, updatePolicy } from './policy.js';
import { Scheduler } from './scheduler.js';
import { ToolExecutor } from './tool-executor.js';
import { ToolModificationHandler } from './tool-modifier.js';
import {
  CoreToolCallStatus,
  ROOT_SCHEDULER_ID,
  type SuccessfulToolCall,
  type ToolCallRequestInfo,
  type ToolCallResponseInfo,
  type WaitingToolCall,
} from './types.js';

interface CallSnapshot {
  callId: string;
  status: CoreToolCallStatus;
  args: Record<string, unknown>;
  correlationId?: string;
}

function snapshotCalls(message: ToolCallsUpdateMessage): CallSnapshot[] {
  return message.toolCalls.map((call) => ({
    callId: call.request.callId,
    status: call.status,
    args: { ...call.request.args },
    correlationId:
      call.status === CoreToolCallStatus.AwaitingApproval
        ? call.correlationId
        : undefined,
  }));
}

describe('Scheduler confirmation call affinity', () => {
  let messageBus: MessageBus;
  let config: Mocked<Config>;
  let executor: Mocked<ToolExecutor>;
  let modifier: Mocked<ToolModificationHandler>;
  let tool: Mocked<AnyDeclarativeTool>;
  let build: ReturnType<typeof vi.fn>;
  let snapshots: CallSnapshot[][];

  beforeEach(() => {
    vi.clearAllMocks();

    const policyEngine = {
      check: vi.fn().mockResolvedValue({
        decision: PolicyDecision.ASK_USER,
      }),
    } as unknown as Mocked<PolicyEngine>;
    messageBus = new MessageBus(policyEngine);
    snapshots = [];
    messageBus.on(
      MessageBusType.TOOL_CALLS_UPDATE,
      (message: ToolCallsUpdateMessage) => {
        snapshots.push(snapshotCalls(message));
      },
    );

    build = vi.fn((args: Record<string, unknown>) => ({
      params: args,
      getDescription: vi.fn().mockReturnValue(`test ${String(args['marker'])}`),
      shouldConfirmExecute: vi.fn().mockResolvedValue({
        type: 'info',
        title: `Approve ${String(args['marker'])}`,
        prompt: 'Approve this call?',
        onConfirm: vi.fn(),
      }),
    }));
    tool = {
      name: 'test-tool',
      description: 'test tool',
      build,
    } as unknown as Mocked<AnyDeclarativeTool>;

    config = {
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getTelemetryLogPromptsEnabled: vi.fn().mockReturnValue(false),
      getTelemetryTracesEnabled: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('affinity-session'),
    } as unknown as Mocked<Config>;

    executor = {
      execute: vi.fn(
        async ({ call }) =>
          ({
            ...call,
            status: CoreToolCallStatus.Success,
            response: {
              callId: call.request.callId,
              responseParts: [],
              resultDisplay: undefined,
              error: undefined,
              errorType: undefined,
            } as ToolCallResponseInfo,
          }) as SuccessfulToolCall,
      ),
    } as unknown as Mocked<ToolExecutor>;
    vi.mocked(ToolExecutor).mockReturnValue(executor);

    modifier = {
      applyInlineModify: vi.fn(async (call: WaitingToolCall, payload) => ({
        updatedParams: {
          ...call.request.args,
          content: 'newContent' in payload ? payload.newContent : undefined,
        },
      })),
      handleModifyWithEditor: vi.fn(),
    } as unknown as Mocked<ToolModificationHandler>;
    vi.mocked(ToolModificationHandler).mockReturnValue(modifier);

    vi.mocked(checkPolicy).mockResolvedValue({
      decision: PolicyDecision.ASK_USER,
      rule: undefined,
    });
    vi.mocked(updatePolicy).mockResolvedValue(undefined);
  });

  it('keeps two out-of-order modified approvals with their correlated calls', async () => {
    const context = {
      config,
      messageBus,
      toolRegistry: {
        getTool: vi.fn().mockReturnValue(tool),
        getAllToolNames: vi.fn().mockReturnValue(['test-tool']),
      },
    } as unknown as AgentLoopContext;
    const scheduler = new Scheduler({
      context,
      messageBus,
      getPreferredEditor: () => undefined,
      schedulerId: ROOT_SCHEDULER_ID,
    });
    const signal = new AbortController().signal;
    const requests: ToolCallRequestInfo[] = [
      {
        callId: 'call-1',
        name: 'test-tool',
        args: { marker: 'one' },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
      {
        callId: 'call-2',
        name: 'test-tool',
        args: { marker: 'two' },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
    ];

    const scheduled = scheduler.schedule(requests, signal);

    await vi.waitFor(() => {
      const latest = snapshots.at(-1) ?? [];
      expect(
        latest.filter(
          (call) => call.status === CoreToolCallStatus.AwaitingApproval,
        ),
      ).toHaveLength(2);
    });

    const waiting = snapshots
      .at(-1)!
      .filter((call) => call.status === CoreToolCallStatus.AwaitingApproval);
    const correlationByCall = new Map(
      waiting.map((call) => [call.callId, call.correlationId!]),
    );

    await messageBus.publish({
      type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      correlationId: correlationByCall.get('call-2')!,
      confirmed: true,
      outcome: ToolConfirmationOutcome.ProceedOnce,
      payload: { newContent: 'two-updated' },
    });

    await vi.waitFor(() => {
      const latest = snapshots.at(-1) ?? [];
      expect(latest.find((call) => call.callId === 'call-2')?.args).toEqual({
        marker: 'two',
        content: 'two-updated',
      });
      expect(latest.find((call) => call.callId === 'call-1')?.status).toBe(
        CoreToolCallStatus.AwaitingApproval,
      );
    });

    await messageBus.publish({
      type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
      correlationId: correlationByCall.get('call-1')!,
      confirmed: true,
      outcome: ToolConfirmationOutcome.ProceedOnce,
      payload: { newContent: 'one-updated' },
    });

    const results = await scheduled;

    expect(
      modifier.applyInlineModify.mock.calls.map(
        ([call]) => call.request.callId,
      ),
    ).toEqual(['call-2', 'call-1']);
    expect(
      modifier.applyInlineModify.mock.calls.map(([call]) => call.request.args),
    ).toEqual([{ marker: 'two' }, { marker: 'one' }]);

    const completedArgs = new Map(
      results.map((call) => [call.request.callId, call.request.args]),
    );
    expect(completedArgs.get('call-1')).toEqual({
      marker: 'one',
      content: 'one-updated',
    });
    expect(completedArgs.get('call-2')).toEqual({
      marker: 'two',
      content: 'two-updated',
    });
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenCalledWith({
      marker: 'one',
      content: 'one-updated',
    });
    expect(build).toHaveBeenCalledWith({
      marker: 'two',
      content: 'two-updated',
    });

    scheduler.dispose();
  });
});
