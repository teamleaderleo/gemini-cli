#!/usr/bin/env python3
"""Run the v1 transform with exact child and PTY registration contexts."""

from __future__ import annotations

import importlib.util
from pathlib import Path


original_path = Path(__file__).with_name(
    "apply-manual-background-temp-ownership.py"
)
spec = importlib.util.spec_from_file_location("fieldwork_manual_background_v1", original_path)
if spec is None or spec.loader is None:
    raise SystemExit(f"cannot load transform: {original_path}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original_replace = module.replace_exact


def replace_compatible(path: Path, old: str, new: str, expected: int = 1) -> None:
    if (
        path.name == "shellExecutionService.ts"
        and expected == 2
        and "completionBehavior" in old
    ):
        original_replace(path, old, new, expected=1)
        child_old = """            completionBehavior:
              shellExecutionConfig.backgroundCompletionBehavior || 'silent',
"""
        child_new = """            onBackgroundClaim: shellExecutionConfig.onBackgroundClaim,
            completionBehavior:
              shellExecutionConfig.backgroundCompletionBehavior || 'silent',
"""
        original_replace(path, child_old, child_new, expected=1)
        return
    original_replace(path, old, new, expected=expected)


module.replace_exact = replace_compatible
raise SystemExit(module.main())
