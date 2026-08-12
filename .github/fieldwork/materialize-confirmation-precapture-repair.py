from pathlib import Path

source_path = Path('packages/core/src/scheduler/confirmation.ts')
source = source_path.read_text(encoding='utf-8')

transition = """    state.updateStatus(callId, CoreToolCallStatus.AwaitingApproval, {
      confirmationDetails: serializableDetails,
      correlationId,
    });

    onWaitingForConfirmation?.(true);
"""
transition_replacement = """    state.updateStatus(callId, CoreToolCallStatus.AwaitingApproval, {
      confirmationDetails: serializableDetails,
      correlationId,
    });
    const approvalGeneration = getWaitingCallForModification(
      state,
      callId,
    ).approvalGeneration;

    onWaitingForConfirmation?.(true);
"""
if source.count(transition) != 1:
    raise SystemExit(f'expected one approval transition, found {source.count(transition)}')
source = source.replace(transition, transition_replacement, 1)

external_call = """      const modResult = await handleExternalModification(
        deps,
        toolCall,
        signal,
      );
"""
external_call_replacement = """      const modResult = await handleExternalModification(
        deps,
        toolCall,
        approvalGeneration,
        signal,
      );
"""
if source.count(external_call) != 1:
    raise SystemExit(f'expected one external modification call, found {source.count(external_call)}')
source = source.replace(external_call, external_call_replacement, 1)

inline_call = """      await handleInlineModification(deps, toolCall, response.payload, signal);
"""
inline_call_replacement = """      await handleInlineModification(
        deps,
        toolCall,
        response.payload,
        approvalGeneration,
        signal,
      );
"""
if source.count(inline_call) != 1:
    raise SystemExit(f'expected one inline modification call, found {source.count(inline_call)}')
source = source.replace(inline_call, inline_call_replacement, 1)

external_signature = """  toolCall: ValidatingToolCall,
  signal: AbortSignal,
): Promise<ExternalModificationResult> {
"""
external_signature_replacement = """  toolCall: ValidatingToolCall,
  expectedApprovalGeneration: number,
  signal: AbortSignal,
): Promise<ExternalModificationResult> {
"""
if source.count(external_signature) != 1:
    raise SystemExit(f'expected one external signature, found {source.count(external_signature)}')
source = source.replace(external_signature, external_signature_replacement, 1)

inline_signature = """  toolCall: ValidatingToolCall,
  payload: ToolConfirmationPayload,
  signal: AbortSignal,
): Promise<void> {
"""
inline_signature_replacement = """  toolCall: ValidatingToolCall,
  payload: ToolConfirmationPayload,
  expectedApprovalGeneration: number,
  signal: AbortSignal,
): Promise<void> {
"""
if source.count(inline_signature) != 1:
    raise SystemExit(f'expected one inline signature, found {source.count(inline_signature)}')
source = source.replace(inline_signature, inline_signature_replacement, 1)

target_lookup = """  const target = getWaitingCallForModification(state, callId);
"""
target_lookup_replacement = """  const target = getWaitingCallForModification(
    state,
    callId,
    expectedApprovalGeneration,
  );
"""
if source.count(target_lookup) != 2:
    raise SystemExit(f'expected two initial target lookups, found {source.count(target_lookup)}')
source = source.replace(target_lookup, target_lookup_replacement)

source_path.write_text(source, encoding='utf-8')


test_path = Path('packages/core/src/scheduler/confirmation.affinity.repair.test.ts')
test = test_path.read_text(encoding='utf-8')
suffix = "\n});\n"
if not test.endswith(suffix):
    raise SystemExit('unexpected test-file ending')

new_tests = r'''

  it('rejects an inline response when onConfirm replaces the approval generation', async () => {
    let harness!: Harness;
    const onConfirm = vi.fn(async () => {
      harness.advanceTargetApprovalGeneration();
    });
    harness = makeHarness([
      {
        type: 'info',
        title: 'Target approval',
        prompt: 'Approve target?',
        onConfirm,
      },
    ]);

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
'''

test = test[: -len(suffix)] + new_tests + suffix
test_path.write_text(test, encoding='utf-8')
