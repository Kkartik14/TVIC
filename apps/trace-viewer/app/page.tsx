import Link from "next/link";

import { listCalls } from "@/lib/artifacts";

export const dynamic = "force-dynamic";

export default async function Home() {
  const calls = await listCalls();

  return (
    <main className="container">
      <div className="h1">T-vic — Trace Viewer</div>
      <div className="sub">Datadog for voice. Every call, decomposed.</div>

      <div style={{ marginTop: 24 }}>
        {calls.length === 0 ? (
          <div className="card sub">
            No calls found. Run a call through the live-call gateway with{" "}
            <span className="mono">RECORD_CALLS=true</span>, or point{" "}
            <span className="mono">CALLS_DIR</span> at a directory of call artifacts.
          </div>
        ) : (
          calls.map((call) => (
            <Link key={call.callId} href={`/calls/${call.callId}`}>
              <div className="call-row">
                <div>
                  <div className="mono">{call.callId}</div>
                  <div className="sub">{call.createdAt ?? "unknown time"}</div>
                </div>
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {call.degraded ? (
                    <span
                      className="pill bad"
                      title="Some artifact writes failed — this record is incomplete"
                    >
                      degraded
                    </span>
                  ) : null}
                  <span className="pill">{call.turns} turns</span>
                  <span className="pill">{(call.durationMs / 1000).toFixed(1)}s</span>
                  {call.interruptions > 0 ? (
                    <span className="pill bad">{call.interruptions} barge-ins</span>
                  ) : null}
                </div>
              </div>
            </Link>
          ))
        )}
      </div>
    </main>
  );
}
