from pathlib import Path

state_path = Path("packages/core/src/scheduler/state-manager.ts")
state = state_path.read_text(encoding="utf-8")

single_replacements = [
    (
        "  private readonly approvalGenerations = new Map<string, number>();\n",
        "  private nextApprovalGeneration = 0;\n",
    ),
    (
        "    const approvalGeneration =\n      (this.approvalGenerations.get(call.request.callId) ?? 0) + 1;\n    this.approvalGenerations.set(call.request.callId, approvalGeneration);\n",
        "    const approvalGeneration = ++this.nextApprovalGeneration;\n",
    ),
]

for old, new in single_replacements:
    count = state.count(old)
    if count != 1:
        raise SystemExit(f"expected one state-manager match, found {count}: {old!r}")
    state = state.replace(old, new, 1)

# Finalization and tail transfer each discard the old per-call counter. The
# scheduler-wide sequence needs neither deletion, so remove both exact lines.
delete_line = "      this.approvalGenerations.delete(callId);\n"
delete_count = state.count(delete_line)
if delete_count != 2:
    raise SystemExit(
        f"expected two approval-generation cleanup lines, found {delete_count}"
    )
state = state.replace(delete_line, "")

state_path.write_text(state, encoding="utf-8")

test_path = Path(
    "packages/core/src/scheduler/state-manager.approval-generation.test.ts"
)
test = test_path.read_text(encoding="utf-8")

test_replacements = [
    (
        "  it('releases generation state when a call is finalized', () => {",
        "  it('does not reuse a generation after a call is finalized', () => {",
    ),
    (
        "      approvalGeneration: 1,\n    });\n  });\n\n  it('releases generation state when ownership transfers to a tail call', () => {",
        "      approvalGeneration: 2,\n    });\n  });\n\n  it('does not reuse a generation when ownership transfers to a tail call', () => {",
    ),
]

for old, new in test_replacements:
    count = test.count(old)
    if count != 1:
        raise SystemExit(f"expected one test match, found {count}: {old!r}")
    test = test.replace(old, new, 1)

# The final expectation is the tail-call lifetime and must also advance.
needle = "      approvalGeneration: 1,\n    });\n  });\n});\n"
if test.count(needle) != 1:
    raise SystemExit(f"expected one tail expectation, found {test.count(needle)}")
test = test.replace(
    needle,
    "      approvalGeneration: 2,\n    });\n  });\n});\n",
    1,
)

test_path.write_text(test, encoding="utf-8")
