from pathlib import Path

source_path = Path('packages/core/src/services/shellExecutionService.ts')
source = source_path.read_text()

old_guard = """    if (!ExecutionLifecycleService.canBackground(pid)) {
      return false;
    }

    const resolvedSessionId =
"""
new_guard = """    const resolvedSessionId =
"""
if source.count(old_guard) != 1:
    raise SystemExit(f'expected one early eligibility guard, found {source.count(old_guard)}')
source = source.replace(old_guard, new_guard, 1)

session_anchor = """    if (!resolvedSessionId) {
      throw new Error('Session ID is required for background operations');
    }

    const MAX_BACKGROUND_PROCESS_HISTORY_SIZE = 100;
"""
session_replacement = """    if (!resolvedSessionId) {
      throw new Error('Session ID is required for background operations');
    }

    if (!ExecutionLifecycleService.canBackground(pid)) {
      return false;
    }

    const MAX_BACKGROUND_PROCESS_HISTORY_SIZE = 100;
"""
if source.count(session_anchor) != 1:
    raise SystemExit(f'expected one session validation anchor, found {source.count(session_anchor)}')
source = source.replace(session_anchor, session_replacement, 1)
source_path.write_text(source)

test_path = Path('packages/core/src/services/shellExecutionService.test.ts')
test = test_path.read_text()

eviction_anchor = """      (ShellExecutionService as any).activeChildProcesses.set(101, {
        process: {},
        state: { output: '' },
        command: 'cmd-101',
        sessionId: 'default',
      });

      ShellExecutionService.background(101, 'default', 'cmd-101');

      const processes =
"""
eviction_replacement = """      (ShellExecutionService as any).activeChildProcesses.set(101, {
        process: {},
        state: { output: '' },
        command: 'cmd-101',
        sessionId: 'default',
      });
      ExecutionLifecycleService.attachExecution(101, {
        executionMethod: 'child_process',
      });

      expect(
        ShellExecutionService.background(101, 'default', 'cmd-101'),
      ).toBe(true);

      const processes =
"""
if test.count(eviction_anchor) != 1:
    raise SystemExit(f'expected one eviction test anchor, found {test.count(eviction_anchor)}')
test = test.replace(eviction_anchor, eviction_replacement, 1)
test_path.write_text(test)

print('FIELDWORK_UNIT_05_CONTRACT_REPAIR=session-first-and-owned-eviction')
