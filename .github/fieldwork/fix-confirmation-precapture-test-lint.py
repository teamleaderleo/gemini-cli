from pathlib import Path

path = Path('packages/core/src/scheduler/confirmation.affinity.repair.test.ts')
text = path.read_text(encoding='utf-8')

old = """    let harness!: Harness;
    const onConfirm = vi.fn(async () => {
      harness.advanceTargetApprovalGeneration();
    });
    harness = makeHarness([
"""
new = """    const harnessRef: { current?: Harness } = {};
    const onConfirm = vi.fn(async () => {
      if (!harnessRef.current) throw new Error('missing test harness');
      harnessRef.current.advanceTargetApprovalGeneration();
    });
    const harness = makeHarness([
"""
if text.count(old) != 1:
    raise SystemExit(f'expected one mutable harness block, found {text.count(old)}')
text = text.replace(old, new, 1)

needle = """      },
    ]);

    const resolution = resolve(harness);
    await waitForConfirmationListener(harness);
    emitResponse(harness, ToolConfirmationOutcome.ProceedOnce, {
      newContent: 'stale inline response',
    });
"""
replacement = """      },
    ]);
    harnessRef.current = harness;

    const resolution = resolve(harness);
    await waitForConfirmationListener(harness);
    emitResponse(harness, ToolConfirmationOutcome.ProceedOnce, {
      newContent: 'stale inline response',
    });
"""
if text.count(needle) != 1:
    raise SystemExit(f'expected one inline response block, found {text.count(needle)}')

path.write_text(text.replace(needle, replacement, 1), encoding='utf-8')
