"""The limits of one investigation, enforced before each model call.

Reaching ADK's max_llm_calls raises and throws the turn away, so the last allowed
call, or the first one after the synthesis deadline, is spent on the final report.
"""
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator

from google.genai import types

FINAL_REPORT_INSTRUCTION = (
    "The investigation budget is used up. Do not call any tool. Return the final "
    "JSON report now, from the evidence already collected, and state in "
    "source_coverage and analytical_gaps what was not examined."
)


@dataclass
class RunBudget:
    max_llm_calls: int
    synthesis_deadline: float
    llm_calls: int = 0
    forced_final: bool = False


_active: dict[str, RunBudget] = {}


@contextmanager
def track_budget(session_id: str, budget: RunBudget) -> Iterator[RunBudget]:
    _active[session_id] = budget
    try:
        yield budget
    finally:
        _active.pop(session_id, None)


def reserve_final_call(callback_context: Any, llm_request: Any) -> None:
    budget = _active.get(callback_context.session.id)
    if budget is None:
        return None
    budget.llm_calls += 1
    if budget.llm_calls >= budget.max_llm_calls or time.monotonic() >= budget.synthesis_deadline:
        budget.forced_final = True
        # Declared tools stay in the request: the history holds their calls.
        llm_request.config.tool_config = types.ToolConfig(
            function_calling_config=types.FunctionCallingConfig(mode=types.FunctionCallingConfigMode.NONE)
        )
        llm_request.append_instructions([FINAL_REPORT_INSTRUCTION])
    return None
