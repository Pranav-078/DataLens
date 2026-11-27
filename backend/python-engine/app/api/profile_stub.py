import asyncio
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class ProfileStubRequest(BaseModel):
    tableCount: int
    # Lets the failure-path test suite trigger each of the Node client's
    # error branches on demand, without needing to kill the process
    # (that's how PROFILER_UNAVAILABLE is tested instead — by pointing the
    # client at a port nothing is listening on).
    simulateFailure: Optional[
        Literal["timeout", "error500", "notimplemented", "malformed"]
    ] = None


@router.post("/internal/profile")
async def post_profile_stub(payload: ProfileStubRequest) -> dict:
    """
    Phase 0 stub: never actually profiles anything. Exists so the Node BFF
    has something real to call, and so every distinct failure mode it must
    handle (unavailable/timeout/501/bad-response/5xx) can be produced on
    demand rather than only theorized about. Phase 1 replaces this
    function's body with real profiling logic; the request/response
    contract stays the same.
    """
    if payload.simulateFailure == "timeout":
        # Long enough to exceed any sane client timeout (Node's default is
        # 5000ms) without hanging a test suite forever.
        await asyncio.sleep(30)

    if payload.simulateFailure == "error500":
        raise HTTPException(status_code=500, detail="Simulated internal error")

    if payload.simulateFailure == "notimplemented":
        raise HTTPException(status_code=501, detail="Not implemented")

    if payload.simulateFailure == "malformed":
        # Deliberately does not match ProfileStubResponse's contract, to
        # exercise the Node client's response-shape validation.
        return {"unexpected_shape": True}

    return {"status": "stub_ok", "receivedTables": payload.tableCount}
