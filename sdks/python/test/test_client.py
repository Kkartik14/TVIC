import asyncio
import json
import struct
import sys
import threading
import tracemalloc
import unittest
from unittest.mock import patch

from websockets.asyncio.client import ClientConnection
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from tvic import (
    RemoteToolContext,
    RemoteVoiceClient,
    RemoteVoiceError,
    RemoteVoiceEvent,
    RemoteVoiceProtocolError,
    RemoteVoiceSession,
)
import tvic.client as client_module


class RemoteVoiceClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_bounded_serializer_ignores_str_subclass_overrides(self) -> None:
        class HostileString(str):
            def __len__(self) -> int:
                return 1

            def __getitem__(self, key):
                return "x" * 8_000_000

        value = HostileString("x" * 300)

        self.assertEqual(
            client_module._bounded_json_dumps(value, 1_024),
            json.dumps("x" * 300, ensure_ascii=True, separators=(",", ":")),
        )

    async def test_bounded_serializer_rejects_javascript_equivalent_unicode_keys(self) -> None:
        value = {"💛": "first", "\ud83d\udc9b": "second"}

        with self.assertRaises(RemoteVoiceProtocolError):
            client_module._bounded_json_dumps(value, 1_024)

    async def test_bounded_serializer_accepts_the_maximum_worker_event_nesting(self) -> None:
        output: object = "leaf"
        for _ in range(client_module._MAX_JSON_CONTAINER_DEPTH - 1):
            output = [output]

        encoded = client_module._bounded_json_dumps(
            {"type": "tool.result", "toolCallId": "tool_depth", "output": output},
            4_096,
        )

        self.assertIn('"type":"tool.result"', encoded)

    async def test_rejects_session_ready_before_session_start_send_begins(self) -> None:
        session_start_send_started = asyncio.Event()
        allow_session_start_send = asyncio.Event()
        send_early_session_ready = asyncio.Event()

        async def worker_handler(websocket) -> None:
            await websocket.recv()
            await websocket.send(
                json.dumps(_agent_ready_message("appointments", "session_early_ready"))
            )
            await send_early_session_ready.wait()
            await websocket.send(
                json.dumps({"type": "session.ready", "sessionId": "session_early_ready"})
            )
            await websocket.wait_closed()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session: RemoteVoiceSession | None = None
            original_send_json = RemoteVoiceSession._send_json

            async def gated_send_json(
                current: RemoteVoiceSession,
                value: dict[str, object],
                **kwargs,
            ) -> None:
                if value.get("type") == "session.start":
                    session_start_send_started.set()
                    await allow_session_start_send.wait()
                await original_send_json(current, value, **kwargs)

            with patch.object(RemoteVoiceSession, "_send_json", gated_send_json):
                connect_task = asyncio.create_task(client.connect("appointments"))
                try:
                    await asyncio.wait_for(session_start_send_started.wait(), timeout=2)
                    send_early_session_ready.set()
                    with self.assertRaises(RemoteVoiceProtocolError):
                        session = await asyncio.wait_for(connect_task, timeout=2)
                finally:
                    allow_session_start_send.set()
                    send_early_session_ready.set()
                    if session is not None:
                        await session.close()
                    elif not connect_task.done():
                        connect_task.cancel()
                        await asyncio.gather(connect_task, return_exceptions=True)

    async def test_accepts_session_ready_after_start_frame_is_written_before_send_returns(self) -> None:
        session_start_frame_written = asyncio.Event()
        allow_send_to_return = asyncio.Event()
        session_ready_sent = asyncio.Event()
        early_ready_rejected = asyncio.Event()

        async def worker_handler(websocket) -> None:
            await websocket.recv()
            await websocket.send(
                json.dumps(_agent_ready_message("appointments", "session_fast_ready"))
            )
            session_start = json.loads(await websocket.recv())
            self.assertEqual(session_start["type"], "session.start")
            await websocket.send(
                json.dumps({"type": "session.ready", "sessionId": "session_fast_ready"})
            )
            session_ready_sent.set()
            await websocket.wait_closed()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session: RemoteVoiceSession | None = None
            original_send = ClientConnection.send
            original_record_failure = RemoteVoiceSession._record_failure

            async def delayed_send(current, message, *args, **kwargs) -> None:
                await original_send(current, message, *args, **kwargs)
                if isinstance(message, str) and json.loads(message).get("type") == "session.start":
                    session_start_frame_written.set()
                    await allow_send_to_return.wait()

            def record_failure(current, error) -> None:
                if isinstance(error, RemoteVoiceProtocolError):
                    early_ready_rejected.set()
                original_record_failure(current, error)

            with (
                patch.object(ClientConnection, "send", delayed_send),
                patch.object(RemoteVoiceSession, "_record_failure", record_failure),
            ):
                connect_task = asyncio.create_task(client.connect("appointments"))
                rejection_task = asyncio.create_task(early_ready_rejected.wait())
                try:
                    await asyncio.wait_for(session_start_frame_written.wait(), timeout=2)
                    await asyncio.wait_for(session_ready_sent.wait(), timeout=2)
                    completed, _ = await asyncio.wait(
                        {connect_task, rejection_task},
                        timeout=2,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    self.assertIn(connect_task, completed)
                    allow_send_to_return.set()
                    session = await asyncio.wait_for(connect_task, timeout=2)
                    self.assertFalse(rejection_task.done())
                finally:
                    allow_send_to_return.set()
                    if session is not None:
                        await session.close()
                    elif not connect_task.done():
                        connect_task.cancel()
                        await asyncio.gather(connect_task, return_exceptions=True)
                    if not rejection_task.done():
                        rejection_task.cancel()
                    await asyncio.gather(rejection_task, return_exceptions=True)

    async def test_reader_protocol_error_is_reported_to_the_event_consumer(self) -> None:
        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_protocol_error")
            await websocket.send("{")

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session = await client.connect("appointments")
            try:
                with self.assertRaises(RemoteVoiceProtocolError):
                    _ = [event async for event in session.events()]
            finally:
                await session.close()

    async def test_reader_classifies_integer_digit_limit_as_protocol_error(self) -> None:
        get_digit_limit = getattr(sys, "get_int_max_str_digits", None)
        if get_digit_limit is None:
            self.skipTest("this Python version has no integer string conversion limit")
        digit_limit = get_digit_limit()
        if digit_limit == 0 or digit_limit + 32 > 32_768:
            self.skipTest(
                "the configured integer limit cannot be exceeded within one control frame"
            )

        raw = f'{{"type":"server.pong","nonce":{"9" * (digit_limit + 1)}}}'
        worker_close_code: int | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_digit_limit")
            await websocket.send(raw)
            await websocket.wait_closed()
            nonlocal worker_close_code
            worker_close_code = websocket.close_code

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect("appointments") as session:
                with self.assertRaises(RemoteVoiceProtocolError):
                    _ = [event async for event in session.events()]

        self.assertEqual(worker_close_code, 4400)

    async def test_tool_call_accepts_fractional_timeout_ms(self) -> None:
        tool_response: dict[str, object] | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_fractional_timeout")
            tool_call = _tool_call_message(
                0,
                session_id="session_fractional_timeout",
                tool_name="fractional_timeout",
            )
            tool_call["timeoutMs"] = 100.5
            await websocket.send(json.dumps(tool_call))
            nonlocal tool_response
            tool_response = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            await websocket.send(json.dumps({"type": "session.ended"}))

        async def fractional_timeout(inputs, context: RemoteToolContext):
            return {"timeout_ms": context.timeout_ms}

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect(
                "appointments", tools={"fractional_timeout": fractional_timeout}
            ) as session:
                _ = [event async for event in session.events()]

        self.assertIsNotNone(tool_response)
        self.assertEqual(tool_response["type"], "tool.result")
        self.assertEqual(tool_response["output"], {"timeout_ms": 100.5})

    async def test_rejects_session_ready_before_agent_ready(self) -> None:
        async def worker_handler(websocket) -> None:
            await websocket.recv()
            await websocket.send(json.dumps({"type": "session.ready"}))

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session = None
            try:
                with self.assertRaises(RemoteVoiceProtocolError):
                    session = await client.connect("appointments")
            finally:
                if session is not None:
                    await session.close()

    async def test_rejects_boolean_protocol_version_in_agent_ready(self) -> None:
        async def worker_handler(websocket) -> None:
            await websocket.recv()
            ready = _agent_ready_message("appointments", "session_boolean_agent_version")
            ready["protocolVersion"] = True
            await websocket.send(json.dumps(ready))
            try:
                await websocket.recv()
            except ConnectionClosed:
                return
            await websocket.send(
                json.dumps(
                    {
                        "type": "session.ready",
                        "sessionId": "session_boolean_agent_version",
                    }
                )
            )
            await websocket.wait_closed()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session: RemoteVoiceSession | None = None
            try:
                with self.assertRaises(RemoteVoiceProtocolError):
                    session = await client.connect("appointments")
            finally:
                if session is not None:
                    await session.close()

    async def test_rejects_boolean_protocol_version_in_session_ready(self) -> None:
        async def worker_handler(websocket) -> None:
            await websocket.recv()
            await websocket.send(
                json.dumps(_agent_ready_message("appointments", "session_boolean_ready_version"))
            )
            await websocket.recv()
            await websocket.send(
                json.dumps(
                    {
                        "type": "session.ready",
                        "sessionId": "session_boolean_ready_version",
                        "protocolVersion": True,
                    }
                )
            )
            await websocket.wait_closed()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session: RemoteVoiceSession | None = None
            try:
                with self.assertRaises(RemoteVoiceProtocolError):
                    session = await client.connect("appointments")
            finally:
                if session is not None:
                    await session.close()

    async def test_rejects_tool_call_before_session_ready_without_running_handler(self) -> None:
        handler_called = asyncio.Event()

        async def worker_handler(websocket) -> None:
            await websocket.recv()
            await websocket.send(json.dumps(_agent_ready_message("appointments", "session_early_tool")))
            await websocket.send(
                json.dumps(
                    {
                        "type": "tool.call",
                        "toolCallId": "tool_early",
                        "sessionId": "session_early_tool",
                        "turnId": "turn_early",
                        "toolName": "side_effect",
                        "attempt": 1,
                        "idempotencyKey": "session_early_tool:tool_early",
                        "timeoutMs": 30_000,
                        "input": {},
                    }
                )
            )
            await websocket.send(
                json.dumps({"type": "session.ready", "sessionId": "session_early_tool"})
            )
            await websocket.wait_closed()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]

            async def side_effect(inputs, context: RemoteToolContext):
                handler_called.set()

            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session = None
            try:
                with self.assertRaises(RemoteVoiceProtocolError):
                    session = await client.connect(
                        "appointments", tools={"side_effect": side_effect}
                    )
            finally:
                if session is not None:
                    await session.close()

        self.assertFalse(handler_called.is_set())

    async def test_rejects_agent_ready_for_a_different_agent(self) -> None:
        async def worker_handler(websocket) -> None:
            await websocket.recv()
            await websocket.send(
                json.dumps(
                    _agent_ready_message(
                        agent_id="different-agent",
                        session_id="session_wrong_agent",
                    )
                )
            )

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session = None
            try:
                with self.assertRaises(RemoteVoiceProtocolError):
                    session = await client.connect("appointments")
            finally:
                if session is not None:
                    await session.close()

    async def test_audio_sequences_restart_after_clear_and_commit(self) -> None:
        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_audio_reset")
            audio = struct.pack("<BBIIH", 1, 0, 1, 0, 0) + b"\x01\x00"
            await websocket.send(audio)
            await websocket.send(json.dumps({"type": "output.clear"}))
            await websocket.send(audio)
            await websocket.send(json.dumps({"type": "output.commit", "commitId": "commit_1"}))
            await websocket.send(audio)
            await websocket.send(json.dumps({"type": "session.ended"}))

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect("appointments") as session:
                events = [event async for event in session.events()]

        self.assertEqual(
            [event.kind for event in events],
            ["audio_output", "output_clear", "audio_output", "output_commit", "audio_output"],
        )

    async def test_send_audio_derives_monotonic_offsets_and_rejects_backwards_offsets(self) -> None:
        received: list[bytes] = []

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_input_offsets")
            received.append(await websocket.recv())
            received.append(await websocket.recv())
            await websocket.send(json.dumps({"type": "session.ended"}))

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect("appointments") as session:
                await session.send_audio(bytes(320))
                await session.send_audio(bytes(320))
                with self.assertRaises(ValueError):
                    await session.send_audio(bytes(320), offset_ms=9)
                _ = [event async for event in session.events()]

        self.assertEqual([struct.unpack_from("<I", frame, 6)[0] for frame in received], [0, 10])

    async def test_explicit_audio_offset_anchors_following_derived_frames(self) -> None:
        received: list[bytes] = []

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_explicit_input_offset")
            received.append(await websocket.recv())
            received.append(await websocket.recv())
            await websocket.send(json.dumps({"type": "session.ended"}))

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect("appointments") as session:
                await session.send_audio(bytes(320), offset_ms=100)
                await session.send_audio(bytes(320))
                _ = [event async for event in session.events()]

        self.assertEqual([struct.unpack_from("<I", frame, 6)[0] for frame in received], [100, 110])

    async def test_oversized_audio_buffers_are_rejected_without_copying(self) -> None:
        oversized = bytearray(8_000_000)
        candidates = (oversized, memoryview(oversized))

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_oversized_audio")
            await websocket.wait_closed()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect("appointments") as session:
                tracemalloc.start()
                try:
                    for candidate in candidates:
                        with self.assertRaises(ValueError):
                            await session.send_audio(candidate)
                    _current, peak = tracemalloc.get_traced_memory()
                finally:
                    tracemalloc.stop()

        self.assertLess(peak, 1_000_000)

    async def test_cancelled_websocket_send_closes_the_connection(self) -> None:
        send_started = asyncio.Event()
        worker_closed = asyncio.Event()
        worker_close_code: int | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_cancelled_control_send")
            await websocket.wait_closed()
            nonlocal worker_close_code
            worker_close_code = websocket.close_code
            worker_closed.set()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect("appointments") as session:
                async def stalled_send(connection, message) -> None:
                    send_started.set()
                    await asyncio.Event().wait()

                with patch.object(client_module.ClientConnection, "send", stalled_send):
                    sending = asyncio.create_task(session._send("test"))
                    await asyncio.wait_for(send_started.wait(), timeout=2)
                    sending.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await sending
                await asyncio.wait_for(worker_closed.wait(), timeout=2)

        self.assertEqual(worker_close_code, 1011)

    async def test_cancelled_audio_send_waiting_for_lock_does_not_skip_sequence(self) -> None:
        received: list[bytes] = []

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_cancelled_audio_send")
            received.append(await websocket.recv())
            received.append(await websocket.recv())
            await websocket.send(json.dumps({"type": "session.ended"}))

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect("appointments") as session:
                await session._send_lock.acquire()
                first = asyncio.create_task(session.send_audio(bytes(320)))
                await asyncio.sleep(0)
                cancelled = asyncio.create_task(session.send_audio(bytes(320)))
                await asyncio.sleep(0)
                cancelled.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await cancelled
                session._send_lock.release()
                await first
                await session.send_audio(bytes(320))
                _ = [event async for event in session.events()]

        self.assertEqual([struct.unpack_from("<I", frame, 2)[0] for frame in received], [1, 2])

    async def test_session_ended_cancels_tools_and_stops_reading_worker_messages(self) -> None:
        handler_started = asyncio.Event()
        handler_cancelled = asyncio.Event()
        worker_closed = asyncio.Event()
        handler_calls = 0

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_ended_is_terminal")
            await websocket.send(
                json.dumps(
                    _tool_call_message(
                        0,
                        session_id="session_ended_is_terminal",
                        tool_name="lookup",
                    )
                )
            )
            await asyncio.wait_for(handler_started.wait(), timeout=2)
            await websocket.send(json.dumps({"type": "session.ended"}))
            await websocket.send(
                json.dumps(
                    _tool_call_message(
                        1,
                        session_id="session_ended_is_terminal",
                        tool_name="lookup",
                    )
                )
            )
            await websocket.wait_closed()
            worker_closed.set()

        async def blocked_handler(inputs, context: RemoteToolContext):
            nonlocal handler_calls
            handler_calls += 1
            handler_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                handler_cancelled.set()
                raise

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect("appointments", tools={"lookup": blocked_handler}) as session:
                events = [event async for event in session.events()]
                self.assertTrue(handler_cancelled.is_set())
            await asyncio.wait_for(worker_closed.wait(), timeout=2)

        self.assertEqual(events, [])
        self.assertTrue(handler_cancelled.is_set())
        self.assertEqual(handler_calls, 1)

    async def test_session_end_does_not_wait_for_slow_tool_cancellation_cleanup(self) -> None:
        handler_started = asyncio.Event()
        handler_cancelled = asyncio.Event()
        allow_handler_cleanup = asyncio.Event()
        handler_finished = asyncio.Event()
        send_session_end = asyncio.Event()

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_slow_tool_cleanup")
            await websocket.send(
                json.dumps(
                    _tool_call_message(
                        0,
                        session_id="session_slow_tool_cleanup",
                        tool_name="slow_cleanup",
                    )
                )
            )
            await send_session_end.wait()
            await websocket.send(json.dumps({"type": "session.ended"}))
            await websocket.wait_closed()

        async def slow_cleanup(inputs, context: RemoteToolContext):
            handler_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                handler_cancelled.set()
                await allow_handler_cleanup.wait()
                handler_finished.set()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect(
                "appointments", tools={"slow_cleanup": slow_cleanup}
            ) as session:
                async def collect_events():
                    return [event async for event in session.events()]

                event_reader = asyncio.create_task(collect_events())
                try:
                    await asyncio.wait_for(handler_started.wait(), timeout=2)
                    send_session_end.set()
                    events = await asyncio.wait_for(event_reader, timeout=2)
                    self.assertEqual(events, [])
                    self.assertTrue(handler_cancelled.is_set())
                finally:
                    allow_handler_cleanup.set()
                await asyncio.wait_for(handler_finished.wait(), timeout=2)

    async def test_cancelled_close_can_be_awaited_again_until_cleanup_finishes(self) -> None:
        send_started = asyncio.Event()
        allow_send = asyncio.Event()
        worker_closed = asyncio.Event()

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_cancelled_close")
            message = json.loads(await websocket.recv())
            self.assertEqual(message["type"], "session.end")
            await websocket.send(json.dumps({"type": "session.ended"}))
            await websocket.wait_closed()
            worker_closed.set()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session = await client.connect("appointments")
            original_send_json = RemoteVoiceSession._send_json

            async def gated_send_json(
                current: RemoteVoiceSession,
                value: dict[str, object],
                **kwargs,
            ) -> None:
                if value.get("type") == "session.end":
                    send_started.set()
                    await allow_send.wait()
                await original_send_json(current, value, **kwargs)

            with patch.object(RemoteVoiceSession, "_send_json", gated_send_json):
                closing = asyncio.create_task(session.close())
                await asyncio.wait_for(send_started.wait(), timeout=2)
                closing.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await closing

                allow_send.set()
                await asyncio.wait_for(session.close(), timeout=2)

            self.assertTrue(session._reader_task.done())
            await asyncio.wait_for(worker_closed.wait(), timeout=2)

    async def test_runtime_error_closes_with_server_error_code(self) -> None:
        worker_close_code: int | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_runtime_error_close")
            await websocket.send(
                json.dumps(
                    {
                        "type": "voice.error",
                        "code": "provider_failed",
                        "message": "provider failed",
                    }
                )
            )
            await websocket.wait_closed()
            nonlocal worker_close_code
            worker_close_code = websocket.close_code

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect("appointments") as session:
                with self.assertRaises(RemoteVoiceError) as raised:
                    _ = [event async for event in session.events()]

        self.assertEqual(raised.exception.code, "provider_failed")
        self.assertEqual(worker_close_code, 1011)

    async def test_oversized_worker_message_is_rejected_at_websocket_limit(self) -> None:
        worker_close_code: int | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_oversized_worker_message")
            await websocket.send("x" * 70_000)
            await websocket.wait_closed()
            nonlocal worker_close_code
            worker_close_code = websocket.close_code

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect("appointments") as session:
                with self.assertRaises(RemoteVoiceError):
                    _ = [event async for event in session.events()]

        self.assertEqual(worker_close_code, 1009)

    async def test_oversized_tool_result_is_bounded_before_serialization(self) -> None:
        result = "x" * 8_000_000
        allow_tool_call = asyncio.Event()
        response_received = asyncio.Event()
        tool_response: dict[str, object] | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_large_tool_result")
            await allow_tool_call.wait()
            await websocket.send(
                json.dumps(
                    _tool_call_message(
                        0,
                        session_id="session_large_tool_result",
                        tool_name="large_result",
                    )
                )
            )
            raw = await asyncio.wait_for(websocket.recv(), timeout=3)
            nonlocal tool_response
            tool_response = json.loads(raw)
            response_received.set()
            await websocket.send(json.dumps({"type": "session.ended"}))

        async def large_result(inputs, context: RemoteToolContext):
            return result

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect("appointments", tools={"large_result": large_result}) as session:
                tracemalloc.start()
                allow_tool_call.set()
                try:
                    await asyncio.wait_for(response_received.wait(), timeout=4)
                    _current, peak = tracemalloc.get_traced_memory()
                finally:
                    tracemalloc.stop()
                _ = [event async for event in session.events()]

        self.assertIsNotNone(tool_response)
        self.assertEqual(tool_response["type"], "tool.error")
        self.assertLess(peak, 1_000_000)

    async def test_tool_result_rejects_integers_outside_javascript_safe_range(self) -> None:
        tool_response: dict[str, object] | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_unsafe_integer")
            await websocket.send(
                json.dumps(
                    _tool_call_message(
                        0,
                        session_id="session_unsafe_integer",
                        tool_name="unsafe_integer",
                    )
                )
            )
            nonlocal tool_response
            tool_response = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            await websocket.send(json.dumps({"type": "session.ended"}))

        async def unsafe_integer(inputs, context: RemoteToolContext):
            return 9_007_199_254_740_993

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect(
                "appointments", tools={"unsafe_integer": unsafe_integer}
            ) as session:
                _ = [event async for event in session.events()]

        self.assertIsNotNone(tool_response)
        self.assertEqual(tool_response["type"], "tool.error")

    async def test_tool_result_rejects_integer_valued_floats_outside_javascript_safe_range(
        self,
    ) -> None:
        tool_response: dict[str, object] | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_unsafe_integer_float")
            await websocket.send(
                json.dumps(
                    _tool_call_message(
                        0,
                        session_id="session_unsafe_integer_float",
                        tool_name="unsafe_integer_float",
                    )
                )
            )
            nonlocal tool_response
            tool_response = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            await websocket.send(json.dumps({"type": "session.ended"}))

        async def unsafe_integer_float(inputs, context: RemoteToolContext):
            return 9_007_199_254_740_992.0

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect(
                "appointments", tools={"unsafe_integer_float": unsafe_integer_float}
            ) as session:
                _ = [event async for event in session.events()]

        self.assertIsNotNone(tool_response)
        self.assertEqual(tool_response["type"], "tool.error")

    async def test_worker_message_rejects_integers_outside_javascript_safe_range(self) -> None:
        handler_called = False
        worker_close_code: int | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_unsafe_worker_integer")
            tool_call = _tool_call_message(
                0,
                session_id="session_unsafe_worker_integer",
                tool_name="unsafe_worker_integer",
            )
            tool_call["input"] = {"id": 9_007_199_254_740_993}
            await websocket.send(json.dumps(tool_call))
            try:
                await asyncio.wait_for(websocket.recv(), timeout=2)
                if websocket.state.name == "OPEN":
                    await websocket.send(json.dumps({"type": "session.ended"}))
            except ConnectionClosed:
                pass
            await websocket.wait_closed()
            nonlocal worker_close_code
            worker_close_code = websocket.close_code

        async def unsafe_worker_integer(inputs, context: RemoteToolContext):
            nonlocal handler_called
            handler_called = True
            return {"seen": inputs}

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect(
                "appointments", tools={"unsafe_worker_integer": unsafe_worker_integer}
            ) as session:
                with self.assertRaises(RemoteVoiceProtocolError):
                    _ = [event async for event in session.events()]

        self.assertFalse(handler_called)
        self.assertEqual(worker_close_code, 4400)

    async def test_worker_message_rejects_numbers_that_overflow_to_infinity(self) -> None:
        handler_called = False
        worker_close_code: int | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_overflow_number")
            tool_call = _tool_call_message(
                0,
                session_id="session_overflow_number",
                tool_name="overflow_number",
            )
            tool_call["input"] = {"id": "__overflow_number__"}
            raw_tool_call = json.dumps(tool_call).replace(
                '"__overflow_number__"', "1e400", 1
            )
            await websocket.send(raw_tool_call)
            try:
                await asyncio.wait_for(websocket.recv(), timeout=2)
                if websocket.state.name == "OPEN":
                    await websocket.send(json.dumps({"type": "session.ended"}))
            except ConnectionClosed:
                pass
            await websocket.wait_closed()
            nonlocal worker_close_code
            worker_close_code = websocket.close_code

        async def overflow_number(inputs, context: RemoteToolContext):
            nonlocal handler_called
            handler_called = True
            return {"seen": inputs}

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect(
                "appointments", tools={"overflow_number": overflow_number}
            ) as session:
                with self.assertRaises(RemoteVoiceProtocolError):
                    _ = [event async for event in session.events()]

        self.assertFalse(handler_called)
        self.assertEqual(worker_close_code, 4400)

    async def test_tool_result_serializes_integer_subclasses_as_integers(self) -> None:
        tool_response: dict[str, object] | None = None

        class MisleadingInteger(int):
            def __str__(self) -> str:
                return "0"

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_integer_subclass")
            await websocket.send(
                json.dumps(
                    _tool_call_message(
                        0,
                        session_id="session_integer_subclass",
                        tool_name="integer_subclass",
                    )
                )
            )
            nonlocal tool_response
            tool_response = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            await websocket.send(json.dumps({"type": "session.ended"}))

        async def integer_subclass(inputs, context: RemoteToolContext):
            return [MisleadingInteger(42), {MisleadingInteger(7): MisleadingInteger(8)}]

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect(
                "appointments", tools={"integer_subclass": integer_subclass}
            ) as session:
                _ = [event async for event in session.events()]

        self.assertIsNotNone(tool_response)
        self.assertEqual(tool_response["type"], "tool.result")
        self.assertEqual(tool_response["output"], [42, {"7": 8}])

    async def test_tool_result_rejects_dictionary_keys_that_collide_in_json(self) -> None:
        tool_response: dict[str, object] | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_duplicate_json_keys")
            await websocket.send(
                json.dumps(
                    _tool_call_message(
                        0,
                        session_id="session_duplicate_json_keys",
                        tool_name="duplicate_json_keys",
                    )
                )
            )
            nonlocal tool_response
            tool_response = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            await websocket.send(json.dumps({"type": "session.ended"}))

        async def duplicate_json_keys(inputs, context: RemoteToolContext):
            return {1: "first", "1": "second"}

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect(
                "appointments", tools={"duplicate_json_keys": duplicate_json_keys}
            ) as session:
                _ = [event async for event in session.events()]

        self.assertIsNotNone(tool_response)
        self.assertEqual(tool_response["type"], "tool.error")

    async def test_tool_result_rejects_unicode_keys_that_collide_in_javascript(self) -> None:
        tool_response: dict[str, object] | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_unicode_json_keys")
            await websocket.send(
                json.dumps(
                    _tool_call_message(
                        0,
                        session_id="session_unicode_json_keys",
                        tool_name="unicode_json_keys",
                    )
                )
            )
            nonlocal tool_response
            tool_response = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            await websocket.send(json.dumps({"type": "session.ended"}))

        async def unicode_json_keys(inputs, context: RemoteToolContext):
            return {"💛": "first", "\ud83d\udc9b": "second"}

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect(
                "appointments", tools={"unicode_json_keys": unicode_json_keys}
            ) as session:
                _ = [event async for event in session.events()]

        self.assertIsNotNone(tool_response)
        self.assertEqual(tool_response["type"], "tool.error")

    async def test_tool_result_rejects_json_deeper_than_worker_event_limit(self) -> None:
        tool_response: dict[str, object] | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_deep_tool_result")
            await websocket.send(
                json.dumps(
                    _tool_call_message(
                        0,
                        session_id="session_deep_tool_result",
                        tool_name="deep_result",
                    )
                )
            )
            nonlocal tool_response
            tool_response = json.loads(await asyncio.wait_for(websocket.recv(), timeout=2))
            await websocket.send(json.dumps({"type": "session.ended"}))

        async def deep_result(inputs, context: RemoteToolContext):
            output: object = "leaf"
            for _ in range(511):
                output = [output]
            return output

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect(
                "appointments", tools={"deep_result": deep_result}
            ) as session:
                _ = [event async for event in session.events()]

        self.assertIsNotNone(tool_response)
        self.assertEqual(tool_response["type"], "tool.error")

    async def test_client_platform_length_uses_javascript_utf16_units(self) -> None:
        client = RemoteVoiceClient("ws://127.0.0.1:1")

        with self.assertRaises(ValueError):
            await client.connect("appointments", client_platform="💛" * 33)

    async def test_unexpected_disconnect_fails_and_cancels_python_tools(self) -> None:
        handler_started = asyncio.Event()
        handler_cancelled = asyncio.Event()
        close_worker = asyncio.Event()

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_disconnect")
            await websocket.send(
                json.dumps(
                    {
                        "type": "tool.call",
                        "toolCallId": "tool_disconnect",
                        "sessionId": "session_disconnect",
                        "turnId": "turn_disconnect",
                        "toolName": "wait_forever",
                        "attempt": 1,
                        "idempotencyKey": "session_disconnect:tool_disconnect",
                        "timeoutMs": 30_000,
                        "input": {},
                    }
                )
            )
            await close_worker.wait()
            await websocket.close()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]

            async def wait_forever(inputs, context: RemoteToolContext):
                handler_started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    handler_cancelled.set()
                    raise

            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session = await client.connect("appointments", tools={"wait_forever": wait_forever})
            try:
                await asyncio.wait_for(handler_started.wait(), timeout=2)
                close_worker.set()
                with self.assertRaises(RemoteVoiceError) as raised:
                    _ = [event async for event in session.events()]
                self.assertEqual(raised.exception.code, "connection_closed")
                await asyncio.wait_for(handler_cancelled.wait(), timeout=2)
            finally:
                await session.close()

    async def test_session_end_reports_event_queue_overflow(self) -> None:
        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_queue_overflow")
            await websocket.send(
                json.dumps({"type": "voice.event", "event": {"kind": "last_event"}})
            )
            await websocket.send(json.dumps({"type": "session.ended"}))

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}", max_pending_events=1)
            async with await client.connect("appointments") as session:
                with self.assertRaises(RemoteVoiceError) as raised:
                    _ = [event async for event in session.events()]

        self.assertEqual(raised.exception.code, "backpressure")

    async def test_failed_backpressure_session_does_not_start_buffered_tool_calls(self) -> None:
        handler_started = asyncio.Event()
        handler_cancelled = asyncio.Event()
        handler_calls = 0

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_backpressure_tool")
            await websocket.wait_closed()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]

            async def side_effect(inputs, context: RemoteToolContext):
                nonlocal handler_calls
                handler_calls += 1
                handler_started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    handler_cancelled.set()
                    raise

            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}", max_pending_events=1)
            session = await client.connect("appointments", tools={"side_effect": side_effect})
            try:
                await session._handle_control(
                    json.dumps(
                        _tool_call_message(
                            0,
                            session_id="session_backpressure_tool",
                            tool_name="side_effect",
                        )
                    )
                )
                await asyncio.wait_for(handler_started.wait(), timeout=2)
                session._enqueue(RemoteVoiceEvent("first", {}))
                session._enqueue(RemoteVoiceEvent("overflow", {}))
                await asyncio.wait_for(handler_cancelled.wait(), timeout=2)
                await session._handle_control(
                    json.dumps(
                        _tool_call_message(
                            1,
                            session_id="session_backpressure_tool",
                            tool_name="side_effect",
                        )
                    )
                )
                self.assertEqual(handler_calls, 1)
            finally:
                await session.close()

    async def test_tool_capacity_closes_session_and_cancels_active_handlers(self) -> None:
        capacity = client_module._MAX_PENDING_TOOLS
        handlers_started = asyncio.Event()
        handlers_cancelled = asyncio.Event()
        worker_closed = asyncio.Event()
        handler_count = 0
        cancelled_count = 0
        worker_close_code: int | None = None

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_tool_overflow")
            for index in range(capacity):
                await websocket.send(json.dumps(_tool_call_message(index)))
            await handlers_started.wait()
            await websocket.send(json.dumps(_tool_call_message(capacity)))
            await websocket.wait_closed()
            nonlocal worker_close_code
            worker_close_code = websocket.close_code
            worker_closed.set()

        async def blocked_handler(inputs, context: RemoteToolContext):
            nonlocal handler_count, cancelled_count
            handler_count += 1
            if handler_count == capacity:
                handlers_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled_count += 1
                if cancelled_count == capacity:
                    handlers_cancelled.set()
                raise

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session = await client.connect("appointments", tools={"wait": blocked_handler})
            try:
                async def drain_events() -> None:
                    async for _event in session.events():
                        pass

                with self.assertRaises(RemoteVoiceError) as raised:
                    await asyncio.wait_for(drain_events(), timeout=2)
                self.assertEqual(raised.exception.code, "tool_capacity")
                await asyncio.wait_for(handlers_cancelled.wait(), timeout=2)
                await asyncio.wait_for(worker_closed.wait(), timeout=2)
                self.assertEqual(handler_count, capacity)
                self.assertEqual(cancelled_count, capacity)
                self.assertEqual(worker_close_code, 1013)
            finally:
                await session.close()

    async def test_unicode_tool_error_fits_the_negotiated_control_frame_limit(self) -> None:
        tool_error: dict[str, object] | None = None
        response_received = asyncio.Event()

        async def worker_handler(websocket) -> None:
            await websocket.recv()
            ready = _agent_ready_message("appointments", "session_unicode_tool_error")
            ready["maxControlFrameBytes"] = 4096
            await websocket.send(json.dumps(ready))
            await websocket.recv()
            await websocket.send(
                json.dumps(
                    {
                        "type": "session.ready",
                        "sessionId": "session_unicode_tool_error",
                    }
                )
            )
            await websocket.send(
                json.dumps(
                    _tool_call_message(
                        0,
                        session_id="session_unicode_tool_error",
                        tool_name="fail",
                    )
                )
            )
            nonlocal tool_error
            try:
                raw = await asyncio.wait_for(websocket.recv(), timeout=2)
                tool_error = json.loads(raw)
            except asyncio.TimeoutError:
                pass
            finally:
                response_received.set()
            await websocket.send(
                json.dumps({"type": "session.ended", "sessionId": "session_unicode_tool_error"})
            )

        async def fail_with_unicode(inputs, context: RemoteToolContext):
            raise ValueError("\x00" * 1_024)

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session = await client.connect("appointments", tools={"fail": fail_with_unicode})
            try:
                await asyncio.wait_for(response_received.wait(), timeout=3)
                self.assertIsNotNone(tool_error)
                self.assertEqual(tool_error["type"], "tool.error")
                self.assertLessEqual(
                    len(json.dumps(tool_error, separators=(",", ":")).encode("utf-8")),
                    4096,
                )
                self.assertTrue(tool_error["error"]["message"])
            finally:
                await session.close()

    async def test_sync_tool_capacity_survives_cancellation_until_thread_finishes(self) -> None:
        tool_started = threading.Event()
        allow_tool_to_finish = threading.Event()
        tool_finished = threading.Event()
        context = RemoteToolContext(
            session_id="session_thread_capacity",
            turn_id="turn_thread_capacity",
            tool_call_id="tool_thread_capacity",
            idempotency_key="session_thread_capacity:tool_thread_capacity",
            attempt=1,
            timeout_ms=None,
            tenant=None,
        )

        def blocking_tool(inputs, context):
            tool_started.set()
            allow_tool_to_finish.wait()
            tool_finished.set()
            return {"ok": True}

        with patch.object(
            client_module, "_SYNC_TOOL_SLOTS", threading.BoundedSemaphore(1), create=True
        ):
            task = asyncio.create_task(
                client_module._invoke_handler(blocking_tool, {}, context)
            )
            try:
                await asyncio.wait_for(asyncio.to_thread(tool_started.wait), timeout=2)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                with self.assertRaises(RemoteVoiceError) as raised:
                    await client_module._invoke_handler(lambda *_: {"ok": True}, {}, context)
                self.assertEqual(raised.exception.code, "tool_capacity")
            finally:
                allow_tool_to_finish.set()
                await asyncio.wait_for(asyncio.to_thread(tool_finished.wait), timeout=2)

            result = None
            for _ in range(100):
                try:
                    result = await client_module._invoke_handler(
                        lambda *_: {"ok": True}, {}, context
                    )
                    break
                except RemoteVoiceError as error:
                    if error.code != "tool_capacity":
                        raise
                    await asyncio.sleep(0.01)
            self.assertEqual(result, {"ok": True})

    async def test_close_finishes_when_session_end_send_stalls(self) -> None:
        send_started = asyncio.Event()
        stall_forever = asyncio.Event()

        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_stalled_close")
            await websocket.wait_closed()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session = await client.connect("appointments")
            original_send_json = RemoteVoiceSession._send_json

            async def gated_send_json(
                current: RemoteVoiceSession,
                value: dict[str, object],
                **kwargs,
            ) -> None:
                if value.get("type") == "session.end":
                    send_started.set()
                    await stall_forever.wait()
                await original_send_json(current, value, **kwargs)

            with patch.object(RemoteVoiceSession, "_send_json", gated_send_json):
                closing = asyncio.create_task(session.close())
                await asyncio.wait_for(send_started.wait(), timeout=2)
                timed_out = False
                try:
                    await asyncio.wait_for(closing, timeout=1)
                except asyncio.TimeoutError:
                    timed_out = True
                finally:
                    stall_forever.set()
                    if session._websocket.state.name == "OPEN":
                        await session._websocket.close()
                    await asyncio.gather(session._reader_task, return_exceptions=True)
                self.assertFalse(timed_out, "close waited indefinitely for session.end")
            self.assertNotEqual(session._websocket.state.name, "OPEN")

    async def test_failed_session_raises_after_queued_terminal_voice_events(self) -> None:
        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_runtime_failure")
            await websocket.send(
                json.dumps(
                    {
                        "type": "voice.event",
                        "event": {
                            "kind": "error",
                            "error": {"message": "runtime failed", "code": "turn.failed"},
                            "recoverable": False,
                        },
                    }
                )
            )
            await websocket.send(
                json.dumps(
                    {
                        "type": "voice.event",
                        "event": {"kind": "call_ended", "reason": "failed", "totalTurns": 0},
                    }
                )
            )
            await websocket.send(json.dumps({"type": "session.ended", "reason": "failed"}))

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            async with await client.connect("appointments") as session:
                observed = []
                with self.assertRaises(RemoteVoiceError) as raised:
                    async for event in session.events():
                        observed.append(event.kind)

        self.assertEqual(raised.exception.code, "session_failed")
        self.assertEqual(observed, ["error", "call_ended"])

    async def test_failed_session_queue_overflow_is_reported_as_backpressure(self) -> None:
        async def worker_handler(websocket) -> None:
            await _complete_handshake(websocket, session_id="session_failed_overflow")
            await websocket.send(
                json.dumps(
                    {
                        "type": "voice.event",
                        "event": {
                            "kind": "error",
                            "error": {"message": "runtime failed", "code": "turn.failed"},
                            "recoverable": False,
                        },
                    }
                )
            )
            await websocket.send(
                json.dumps(
                    {
                        "type": "voice.event",
                        "event": {"kind": "call_ended", "reason": "failed", "totalTurns": 0},
                    }
                )
            )
            await websocket.send(json.dumps({"type": "session.ended", "reason": "failed"}))

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}", max_pending_events=2)
            async with await client.connect("appointments") as session:
                observed = []
                with self.assertRaises(RemoteVoiceError) as raised:
                    async for event in session.events():
                        observed.append(event.kind)

        self.assertEqual(raised.exception.code, "backpressure")
        self.assertEqual(observed, ["call_ended"])

    async def test_connects_streams_audio_and_returns_python_tool_results(self) -> None:
        tool_contexts: list[RemoteToolContext] = []
        received_audio: list[bytes] = []
        received_turn_end = asyncio.Event()
        server_failure: list[BaseException] = []
        large_input = "x" * 5_000
        large_output = "y" * 5_000

        async def worker_handler(websocket) -> None:
            try:
                agent_start = json.loads(await websocket.recv())
                self.assertEqual(agent_start["type"], "agent.start")
                self.assertEqual(agent_start["protocolVersion"], 1)
                self.assertEqual(agent_start["clientPlatform"], "python")
                self.assertEqual(websocket.request.path, "/v1/agents/appointments")

                await websocket.send(
                    json.dumps(
                        {
                            "type": "agent.ready",
                            "protocolVersion": 1,
                            "agentId": "appointments",
                            "sessionId": "session_python_test",
                            "callId": "call_python_test",
                            "audioFormat": {
                                "encoding": "pcm_s16le",
                                "sampleRateHz": 16000,
                                "channels": 1,
                            },
                            "maxControlFrameBytes": 32768,
                        }
                    )
                )
                session_start = json.loads(await websocket.recv())
                self.assertEqual(session_start["type"], "session.start")
                self.assertEqual(session_start["audioFormat"]["sampleRateHz"], 16000)
                await websocket.send(
                    json.dumps(
                        {
                            "type": "session.ready",
                            "sessionId": "session_python_test",
                            "callId": "call_python_test",
                            "mode": "push_to_talk",
                        }
                    )
                )
                await websocket.send(
                    json.dumps(
                        {
                            "type": "tool.call",
                            "toolCallId": "tool_python_test",
                            "sessionId": "session_python_test",
                            "turnId": "turn_python_test",
                            "toolName": "lookup_customer",
                            "attempt": 1,
                            "idempotencyKey": "session_python_test:tool_python_test",
                            "timeoutMs": 5_000,
                            "tenant": {"userId": "user_1"},
                            "input": {"payload": large_input},
                        }
                    )
                )

                got_result = False
                got_audio = False
                while not (got_result and got_audio and received_turn_end.is_set()):
                    incoming = await websocket.recv()
                    if isinstance(incoming, bytes):
                        received_audio.append(incoming)
                        got_audio = True
                    else:
                        message = json.loads(incoming)
                        if message["type"] == "tool.result":
                            self.assertEqual(message["toolCallId"], "tool_python_test")
                            self.assertEqual(message["output"], {"payload": large_output})
                            got_result = True
                        elif message["type"] == "turn.end":
                            received_turn_end.set()

                await websocket.send(struct.pack("<BBIIH", 1, 0, 1, 24, 0) + b"\x01\x00")
                await websocket.send(
                    json.dumps(
                        {
                            "type": "voice.event",
                            "event": {"kind": "tool_result", "output": {"found": True}},
                        }
                    )
                )
                await websocket.send(json.dumps({"type": "session.ended"}))
            except BaseException as error:
                server_failure.append(error)
                raise

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]

            async def lookup_customer(inputs, context: RemoteToolContext):
                self.assertEqual(inputs, {"payload": large_input})
                tool_contexts.append(context)
                return {"payload": large_output}

            client = RemoteVoiceClient(f"http://127.0.0.1:{port}")
            async with await client.connect(
                "appointments", tools={"lookup_customer": lookup_customer}
            ) as session:
                self.assertEqual(session.session_id, "session_python_test")
                await session.send_audio(b"\x00\x00\x01\x00", offset_ms=12)
                await session.end_turn()
                events = [event async for event in session.events()]

            self.assertEqual([event.kind for event in events], ["audio_output", "tool_result"])
            self.assertEqual(events[0].payload["audio"], b"\x01\x00")
            self.assertEqual(events[0].payload["monotonic_offset_ms"], 24)

        self.assertEqual(len(received_audio), 1)
        version, flags, sequence, offset_ms, reserved = struct.unpack_from(
            "<BBIIH", received_audio[0]
        )
        self.assertEqual((version, flags, sequence, offset_ms, reserved), (1, 0, 1, 12, 0))
        self.assertEqual(received_audio[0][12:], b"\x00\x00\x01\x00")
        self.assertEqual(tool_contexts[0].idempotency_key, "session_python_test:tool_python_test")
        self.assertEqual(tool_contexts[0].tenant, {"userId": "user_1"})
        self.assertFalse(server_failure)

    async def test_tool_cancel_cancels_the_python_handler(self) -> None:
        handler_started = asyncio.Event()
        handler_cancelled = asyncio.Event()
        send_cancel = asyncio.Event()

        async def worker_handler(websocket) -> None:
            await websocket.recv()
            await websocket.send(
                json.dumps(
                    {
                        "type": "agent.ready",
                        "protocolVersion": 1,
                        "agentId": "appointments",
                        "sessionId": "session_cancel_test",
                        "callId": "call_cancel_test",
                        "audioFormat": {
                            "encoding": "pcm_s16le",
                            "sampleRateHz": 16000,
                            "channels": 1,
                        },
                        "maxControlFrameBytes": 32768,
                    }
                )
            )
            await websocket.recv()
            await websocket.send(
                json.dumps(
                    {
                        "type": "session.ready",
                        "sessionId": "session_cancel_test",
                    }
                )
            )
            await websocket.send(
                json.dumps(
                    {
                        "type": "tool.call",
                        "toolCallId": "tool_cancel_test",
                        "sessionId": "session_cancel_test",
                        "turnId": "turn_cancel_test",
                        "toolName": "wait_forever",
                        "attempt": 1,
                        "idempotencyKey": "session_cancel_test:tool_cancel_test",
                        "timeoutMs": 30_000,
                        "input": {},
                    }
                )
            )
            await send_cancel.wait()
            await websocket.send(
                json.dumps({"type": "tool.cancel", "toolCallId": "tool_cancel_test"})
            )
            await websocket.close()

        async with serve(worker_handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]

            async def wait_forever(inputs, context: RemoteToolContext):
                handler_started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    handler_cancelled.set()
                    raise

            client = RemoteVoiceClient(f"ws://127.0.0.1:{port}")
            session = await client.connect("appointments", tools={"wait_forever": wait_forever})
            await asyncio.wait_for(handler_started.wait(), timeout=2)
            send_cancel.set()
            await asyncio.wait_for(handler_cancelled.wait(), timeout=2)
            await session.close()


async def _complete_handshake(websocket, *, session_id: str) -> None:
    await websocket.recv()
    await websocket.send(json.dumps(_agent_ready_message("appointments", session_id)))
    await websocket.recv()
    await websocket.send(json.dumps({"type": "session.ready", "sessionId": session_id}))


def _tool_call_message(
    index: int,
    *,
    session_id: str = "session_tool_overflow",
    tool_name: str = "wait",
) -> dict[str, object]:
    tool_call_id = f"tool_{index}"
    return {
        "type": "tool.call",
        "toolCallId": tool_call_id,
        "sessionId": session_id,
        "turnId": f"turn_{index}",
        "toolName": tool_name,
        "attempt": 1,
        "idempotencyKey": f"{session_id}:{tool_call_id}",
        "timeoutMs": 30_000,
        "input": {},
    }


def _agent_ready_message(agent_id: str, session_id: str) -> dict[str, object]:
    return {
        "type": "agent.ready",
        "protocolVersion": 1,
        "agentId": agent_id,
        "sessionId": session_id,
        "callId": f"call_{session_id}",
        "audioFormat": {
            "encoding": "pcm_s16le",
            "sampleRateHz": 16000,
            "channels": 1,
        },
        "maxControlFrameBytes": 32768,
    }


if __name__ == "__main__":
    unittest.main()
