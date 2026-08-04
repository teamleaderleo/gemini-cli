from pathlib import Path

source_path = Path('packages/core/src/scheduler/state-manager.ts')
source = source_path.read_text(encoding='utf-8')

finalize_old = """      this._completedBatch.push(call);
      this.activeCalls.delete(callId);

      this.onTerminalCall?.(call);
"""
finalize_new = """      this._completedBatch.push(call);
      this.activeCalls.delete(callId);
      this.approvalGenerations.delete(callId);

      this.onTerminalCall?.(call);
"""
if source.count(finalize_old) != 1:
    raise SystemExit(
        f'expected one terminal ownership release, found {source.count(finalize_old)}'
    )
source = source.replace(finalize_old, finalize_new, 1)

tail_old = """    if (this.activeCalls.has(callId)) {
      this.activeCalls.delete(callId);
      this.queue.unshift(nextCall);
"""
tail_new = """    if (this.activeCalls.has(callId)) {
      this.activeCalls.delete(callId);
      this.approvalGenerations.delete(callId);
      this.queue.unshift(nextCall);
"""
if source.count(tail_old) != 1:
    raise SystemExit(
        f'expected one tail-call ownership release, found {source.count(tail_old)}'
    )
source_path.write_text(source.replace(tail_old, tail_new, 1), encoding='utf-8')

test_path = Path(
    'packages/core/src/scheduler/state-manager.approval-generation.test.ts'
)
test = test_path.read_text(encoding='utf-8')
marker = "\n});\n"
addition = """

  it('releases generation state when a call is finalized', () => {
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
      approvalGeneration: 1,
    });
  });

  it('releases generation state when ownership transfers to a tail call', () => {
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
      approvalGeneration: 1,
    });
  });
"""
position = test.rfind(marker)
if position < 0:
    raise SystemExit('could not find approval-generation describe terminator')
if 'releases generation state when a call is finalized' in test:
    raise SystemExit('generation cleanup tests already exist')
test_path.write_text(test[:position] + addition + test[position:], encoding='utf-8')
