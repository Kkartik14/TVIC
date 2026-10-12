import asyncio
import json
import subprocess
import unittest
from pathlib import Path

from tvic import RemoteToolContext, RemoteVoiceClient


class NodePythonInteropTests(unittest.IsolatedAsyncioTestCase):
    async def test_python_tool_handler_runs_in_the_real_node_worker(self) -> None:
        repository = Path(__file__).resolve().parents[3]
        worker = Path(__file__).parent / "fixtures" / "remote_worker.mjs"
        process = subprocess.Popen(
            ["node", str(worker)],
            cwd=repository,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            if process.stdout is None:
                raise AssertionError("Node worker stdout was not captured")
            ready_line = await asyncio.wait_for(asyncio.to_thread(process.stdout.readline), 10)
            if not ready_line:
                error = ""
                if process.stderr is not None:
                    error = await asyncio.to_thread(process.stderr.read)
                raise AssertionError(f"Node worker did not report readiness: {error}")
            port = json.loads(ready_line)["port"]

            async def lookup_customer(inputs, context: RemoteToolContext):
                self.assertEqual(inputs, {"email": "person@example.com"})
                self.assertEqual(context.tool_call_id, "tool_node_python_test")
                self.assertEqual(context.timeout_ms, 100.5)
                return {"found": True}

            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect(
                "appointments", tools={"lookup_customer": lookup_customer}
            ) as session:
                events = [event async for event in session.events()]

            self.assertEqual(
                [event.kind for event in events],
                ["tool_result", "call_ended"],
            )
            self.assertEqual(events[0].payload["output"], {"found": True})
        finally:
            process.terminate()
            try:
                await asyncio.wait_for(asyncio.to_thread(process.wait), timeout=5)
            except asyncio.TimeoutError:
                process.kill()
                await asyncio.to_thread(process.wait)
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()


if __name__ == "__main__":
    unittest.main()
