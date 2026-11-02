import { NextResponse } from "next/server";
import { readWorkbenchState, updateWorkbenchState } from "@/lib/workbench/workflow-store";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { validSessionId, WorkbenchError } from "@/lib/workbench/workflow";
export const dynamic = "force-dynamic";
function failure(error: unknown) {
  return NextResponse.json({ error: error instanceof WorkbenchError ? error.code : "storage", }, { status: error instanceof WorkbenchError ? error.status : 500 });
}
export async function GET() {
  try { return NextResponse.json(readWorkbenchState(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const text = await request.text();
    if (text.length > 256 * 1024) throw new WorkbenchError("limit", 413);
    let body;
    try { body = JSON.parse(text); } catch { throw new WorkbenchError("invalid"); }
    if (!body || !Number.isSafeInteger(body.revision) || !body.action || typeof body.action !== "object") throw new WorkbenchError("invalid");
    const action = body.action;
    if (action.sessionId !== undefined) {
      if (!validSessionId(action.sessionId)) throw new WorkbenchError("invalid");
      const live = getRpcSession(action.sessionId);
      if (!live && !await resolveSessionPath(action.sessionId)) throw new WorkbenchError("missing", 404);
      if (live?.isRunning()) throw new WorkbenchError("busy", 409);
    }
    return NextResponse.json(await updateWorkbenchState(action, body.revision, undefined, () => {
      // Lock acquisition can await another writer; recheck activity at the commit boundary.
      if (action.sessionId && getRpcSession(action.sessionId)?.isRunning()) throw new WorkbenchError("busy", 409);
    }));
  } catch (error) { return failure(error); }
}
