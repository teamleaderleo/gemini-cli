/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export class ConfirmationWaitTracker {
  private activeWaits = 0;

  constructor(private readonly onWaitingChange?: (waiting: boolean) => void) {}

  readonly update = (waiting: boolean): void => {
    if (waiting) {
      if (this.activeWaits === 0) {
        this.onWaitingChange?.(true);
      }
      this.activeWaits += 1;
      return;
    }

    if (this.activeWaits === 0) {
      throw new Error(
        'Cannot clear confirmation waiting state without an active wait',
      );
    }

    this.activeWaits -= 1;
    if (this.activeWaits === 0) {
      this.onWaitingChange?.(false);
    }
  };
}
