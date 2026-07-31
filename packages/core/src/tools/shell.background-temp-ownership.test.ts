/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const executeMock = vi.hoisted(() => vi.fn());
const backgroundMock = vi.hoisted(() => vi.fn());

vi.mock('../services/shellExecutionService.js', () => ({
  ShellExecutionService: {
    execute: executeMock,
    background: backgroundMock,
  },
}));

import type { Config } from '../config/config.js';
import { NoopSandboxManager } from '../services/sandboxManager.js';
import type {
  ShellExecutionResult,
  ShellOutputEvent,
} from '../services/shellExecutionService.js';
import { createMockMessageBus } from '../test-utils/mock-message-bus.js';
import { initializeShellParsers } from '../utils/shell-utils.js';
import { isSubpath } from '../utils/paths.js';
import { WorkspaceContext } from '../utils/workspaceContext.js';
import { ShellTool } from './shell.js';

function completedResult(): ShellExecutionResult {
  return {
    rawOutput: Buffer.from(''),
    output: '',
    exitCode: 0,
    signal: null,
    error: null,
    aborted: false,
    pid: 12345,
    executionMethod: 'child_process',
  };
}

describe('background shell temporary-resource ownership', () => {
  let shellTool: ShellTool;
  let targetDir: string;
  let extractedTempFile: string | undefined;
  let resolveExecution: (result: ShellExecutionResult) => void;

  beforeAll(async () => {
    await initializeShellParsers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-temp-owner-test-'));
    extractedTempFile = undefined;

    const sandboxManager = new NoopSandboxManager();
    const config = {
      get config() {
        return this;
      },
      geminiClient: {
        stripThoughtsFromHistory: vi.fn(),
      },
      env: {},
      getAllowedTools: vi.fn().mockReturnValue([]),
      getApprovalMode: vi.fn().mockReturnValue('strict'),
      getCoreTools: vi.fn().mockReturnValue([]),
      getExcludeTools: vi.fn().mockReturnValue(new Set()),
      getDebugMode: vi.fn().mockReturnValue(false),
      getTargetDir: vi.fn().mockReturnValue(targetDir),
      getSummarizeToolOutputConfig: vi.fn().mockReturnValue(undefined),
      getWorkspaceContext: vi
        .fn()
        .mockReturnValue(new WorkspaceContext(targetDir)),
      getGeminiClient: vi.fn().mockReturnValue({}),
      getShellToolInactivityTimeout: vi.fn().mockReturnValue(1_000),
      getEnableInteractiveShell: vi.fn().mockReturnValue(false),
      isInteractiveShellEnabled: vi.fn().mockReturnValue(false),
      getShellBackgroundCompletionBehavior: vi.fn().mockReturnValue('silent'),
      getEnableShellOutputEfficiency: vi.fn().mockReturnValue(true),
      getSandboxEnabled: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('fieldwork-session'),
      sanitizationConfig: {},
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue(targetDir),
      },
      get sandboxManager() {
        return sandboxManager;
      },
      sandboxPolicyManager: {
        getCommandPermissions: vi.fn().mockReturnValue({
          fileSystem: { read: [], write: [] },
          network: false,
        }),
        getModeConfig: vi.fn().mockReturnValue({ readonly: false }),
        addPersistentApproval: vi.fn(),
        addSessionApproval: vi.fn(),
      },
      isPathAllowed(this: Config, absolutePath: string): boolean {
        const workspaceContext = this.getWorkspaceContext();
        return (
          workspaceContext.isPathWithinWorkspace(absolutePath) ||
          isSubpath(path.resolve(this.storage.getProjectTempDir()), absolutePath)
        );
      },
      validatePathAccess(this: Config, absolutePath: string): string | null {
        return this.isPathAllowed(absolutePath)
          ? null
          : `Path not in workspace: ${absolutePath}`;
      },
    } as unknown as Config;

    shellTool = new ShellTool(config, createMockMessageBus());

    executeMock.mockImplementation(
      (
        command: string,
        _cwd: string,
        _onOutput: (event: ShellOutputEvent) => void,
      ) => {
        const match = command.match(/_bgpids_file=([^\r\n]+)/);
        extractedTempFile = match?.[1].replace(/['"]/g, '');
        return {
          pid: 12345,
          result: new Promise<ShellExecutionResult>((resolve) => {
            resolveExecution = resolve;
          }),
        };
      },
    );
  });

  afterEach(() => {
    if (extractedTempFile) {
      fs.rmSync(path.dirname(extractedTempFile), {
        recursive: true,
        force: true,
      });
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  });

  it('retains the PID directory after a short command requested as background completes', async () => {
    const invocation = shellTool.build({
      command: 'true',
      is_background: true,
      delay_ms: 0,
    });

    const execution = invocation.execute({
      abortSignal: new AbortController().signal,
    });

    await vi.waitFor(() => {
      expect(executeMock).toHaveBeenCalledTimes(1);
      expect(extractedTempFile).toBeDefined();
    });

    resolveExecution(completedResult());
    await execution;

    expect(backgroundMock).toHaveBeenCalledWith(
      12345,
      'fieldwork-session',
      'true',
    );
    expect(extractedTempFile).toBeDefined();
    expect(fs.existsSync(path.dirname(extractedTempFile!))).toBe(true);
  });
});
