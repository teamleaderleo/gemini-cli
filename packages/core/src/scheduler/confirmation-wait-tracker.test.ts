/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ConfirmationWaitTracker } from './confirmation-wait-tracker.js';

describe('ConfirmationWaitTracker', () => {
  it('keeps aggregate waiting true until every overlapping wait clears', () => {
    const onWaitingChange = vi.fn();
    const tracker = new ConfirmationWaitTracker(onWaitingChange);

    tracker.update(true);
    tracker.update(true);
    tracker.update(false);
    expect(onWaitingChange.mock.calls.map(([waiting]) => waiting)).toEqual([
      true,
    ]);

    tracker.update(false);
    expect(onWaitingChange.mock.calls.map(([waiting]) => waiting)).toEqual([
      true,
      false,
    ]);
  });

  it('rejects an unmatched clear instead of hiding ownership drift', () => {
    const tracker = new ConfirmationWaitTracker();
    expect(() => tracker.update(false)).toThrow('without an active wait');
  });

  it('does not retain a wait when the initial observer throws', () => {
    const onWaitingChange = vi.fn((_waiting: boolean) => {});
    onWaitingChange.mockImplementationOnce(() => {
      throw new Error('observer start failed');
    });
    const tracker = new ConfirmationWaitTracker(onWaitingChange);

    expect(() => tracker.update(true)).toThrow('observer start failed');
    expect(() => tracker.update(false)).toThrow('without an active wait');
  });
});
