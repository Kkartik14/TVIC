from __future__ import annotations

import asyncio
import threading
import inspect
import json
import math
import re
import struct
from concurrent.futures import ThreadPoolExecutor
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal, TypeAlias
from urllib.parse import quote, urlsplit, urlunsplit

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

Mode: TypeAlias = Literal["push_to_talk", "continuous"]
ToolHandler: TypeAlias = Callable[[Any, "RemoteToolContext"], Any]
_PROTOCOL_VERSION = 1
_AUDIO_HEADER = struct.Struct("<BBIIH")
_MAX_AUDIO_FRAME_BYTES = 65_536
_MAX_MESSAGE_BYTES = _MAX_AUDIO_FRAME_BYTES
_MAX_PENDING_TOOLS = 32
_MAX_JSON_CONTAINER_DEPTH = 511
_MAX_UINT32 = 0xFFFF_FFFF
_MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991
_SESSION_END_SEND_TIMEOUT_SECONDS = 0.5
_TOOL_CLEANUP_TIMEOUT_SECONDS = 0.1
_SYNC_TOOL_WORKERS = _MAX_PENDING_TOOLS
_SYNC_TOOL_EXECUTOR = ThreadPoolExecutor(
    max_workers=_SYNC_TOOL_WORKERS,
    thread_name_prefix="tvic-tool",
)
_SYNC_TOOL_SLOTS = threading.BoundedSemaphore(_SYNC_TOOL_WORKERS)


class RemoteVoiceError(RuntimeError):
    """A connection or runtime error returned by the TVIC worker."""

    def __init__(self, message: str, *, code: str = "remote_voice_error") -> None:
        super().__init__(message)
        self.code = code


class RemoteVoiceProtocolError(RemoteVoiceError):
    """The worker sent a message that does not match protocol v1."""


@dataclass(frozen=True)
class RemoteVoiceEvent:
    """One runtime event. Audio output events carry PCM bytes in ``payload``."""

    kind: str
    payload: Mapping[str, Any]


@dataclass(frozen=True)
class RemoteToolContext:
    """Context supplied to a Python tool handler for one TVIC tool call."""

    session_id: str
    turn_id: str
    tool_call_id: str
    idempotency_key: str
    attempt: int
    timeout_ms: float | None
    tenant: Mapping[str, Any] | None


class RemoteVoiceClient:
    """Connect to an application-hosted TVIC Node worker."""

    def __init__(
        self,
        endpoint: str,
        *,
        headers: Mapping[str, str] | None = None,
        open_timeout: float = 10.0,
        max_pending_events: int = 256,
    ) -> None:
        self._endpoint = _normalize_endpoint(endpoint)
        self._headers = dict(headers or {})
        self._open_timeout = open_timeout
        self._max_pending_events = max_pending_events
        if (
            not isinstance(max_pending_events, int)
            or isinstance(max_pending_events, bool)
            or max_pending_events < 1
        ):
            raise ValueError("max_pending_events must be positive")

    async def connect(
        self,
        agent_id: str,
        *,
        tools: Mapping[str, ToolHandler] | None = None,
        mode: Mode = "push_to_talk",
        client_platform: str = "python",
    ) -> RemoteVoiceSession:
        """Open a call to a named agent registered by the consumer's Node worker."""
        if not isinstance(agent_id, str) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", agent_id
        ):
            raise ValueError("agent_id must be a valid 1 to 128 character route name")
        if mode not in ("push_to_talk", "continuous"):
            raise ValueError("mode must be 'push_to_talk' or 'continuous'")
        if (
            not isinstance(client_platform, str)
            or not client_platform
            or len(client_platform.encode("utf-16-le", errors="surrogatepass")) > 128
        ):
            raise ValueError("client_platform must contain 1 to 64 UTF-16 code units")

        uri = f"{self._endpoint}/v1/agents/{quote(agent_id, safe='')}"
        websocket = await connect(
            uri,
            additional_headers=self._headers,
            open_timeout=self._open_timeout,
            max_size=_MAX_MESSAGE_BYTES,
            ping_interval=None,
            compression=None,
        )
        session = RemoteVoiceSession(
            websocket,
            expected_agent_id=agent_id,
            tools=tools or {},
            mode=mode,
            client_platform=client_platform,
            max_pending_events=self._max_pending_events,
        )
        try:
            await session._start()
            return session
        except BaseException:
            await session.close()
            raise


class RemoteVoiceSession:
    """One live audio session connected to a consumer-hosted TVIC worker."""

    def __init__(
        self,
        websocket: ClientConnection,
        *,
        expected_agent_id: str,
        tools: Mapping[str, ToolHandler],
        mode: Mode,
        client_platform: str,
        max_pending_events: int,
    ) -> None:
        self._websocket = websocket
        self._expected_agent_id = expected_agent_id
        self._tools = dict(tools)
        self._mode = mode
        self._client_platform = client_platform
        self._session_id: str | None = None
        self._call_id: str | None = None
        self._agent_id: str | None = None
        self._session_start_send_started = False
        self._input_sequence = 0
        self._input_samples_sent = 0
        self._input_offset_anchor_samples = 0
        self._input_offset_anchor_ms = 0
        self._input_last_offset_ms: int | None = None
        self._output_sequence = 0
        self._max_control_frame_bytes = 4_096
        self._closed = False
        self._close_task: asyncio.Task[None] | None = None
        self._failure: RemoteVoiceError | None = None
        self._end_enqueued = False
        self._normal_end_received = False
        self._send_lock = asyncio.Lock()
        self._events: asyncio.Queue[RemoteVoiceEvent | None] = asyncio.Queue(max_pending_events)
        self._session_ready: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._tool_tasks: dict[str, asyncio.Task[None]] = {}
        self._reader_task = asyncio.create_task(self._read_loop())
        self._heartbeat_task: asyncio.Task[None] | None = None

    @property
    def session_id(self) -> str | None:
        return self._session_id

    @property
    def call_id(self) -> str | None:
        return self._call_id

    @property
    def agent_id(self) -> str | None:
        return self._agent_id

    async def _start(self) -> None:
        await self._send_json(
            {
                "type": "agent.start",
                "protocolVersion": _PROTOCOL_VERSION,
                "mode": self._mode,
                "clientPlatform": self._client_platform,
            }
        )
        try:
            await asyncio.wait_for(asyncio.shield(self._session_ready), timeout=15.0)
        except asyncio.TimeoutError as error:
            raise RemoteVoiceError("timed out waiting for the TVIC session to become ready") from error
        self._heartbeat_task = asyncio.create_task(self._heartbeat())

    async def send_audio(
        self,
        pcm_s16le: bytes | bytearray | memoryview,
        *,
        offset_ms: int | None = None,
    ) -> None:
        """Send PCM16 16 kHz mono audio, deriving offsets from sent samples by default."""
        if self._mode not in ("push_to_talk", "continuous"):
            raise RemoteVoiceError("session is not ready")
        try:
            payload_view = memoryview(pcm_s16le)
        except TypeError as error:
            raise ValueError("audio must be a bytes-like PCM16 buffer") from error
        payload_size = payload_view.nbytes
        if not payload_size or payload_size % 2:
            raise ValueError("audio must contain a non-empty even number of PCM16 bytes")
        if _AUDIO_HEADER.size + payload_size > _MAX_AUDIO_FRAME_BYTES:
            raise ValueError("audio frame exceeds 65536 bytes")
        payload = pcm_s16le if isinstance(pcm_s16le, bytes) else payload_view.tobytes()
        if offset_ms is not None and (
            not isinstance(offset_ms, int)
            or isinstance(offset_ms, bool)
            or not 0 <= offset_ms <= _MAX_UINT32
        ):
            raise ValueError("offset_ms must be an integer from 0 to 4294967295")
        async with self._send_lock:
            if self._websocket.state.name != "OPEN":
                raise RemoteVoiceError("TVIC session is disconnected", code="connection_closed")
            if self._input_sequence >= _MAX_UINT32:
                raise RemoteVoiceError("input audio sequence limit reached")
            next_offset_ms = self._input_offset_anchor_ms + (
                self._input_samples_sent - self._input_offset_anchor_samples
            ) // 16
            if offset_ms is not None:
                next_offset_ms = offset_ms
            if self._input_last_offset_ms is not None and next_offset_ms < self._input_last_offset_ms:
                raise ValueError("offset_ms must not move backwards")
            if next_offset_ms > _MAX_UINT32:
                raise RemoteVoiceError("input audio offset limit reached")
            next_sequence = self._input_sequence + 1
            frame = _AUDIO_HEADER.pack(1, 0, next_sequence, next_offset_ms, 0) + payload
            try:
                await self._websocket.send(frame)
            except asyncio.CancelledError:
                if self._websocket.state.name == "OPEN":
                    await self._websocket.close(code=1011, reason="audio send cancelled")
                raise
            if offset_ms is not None:
                self._input_offset_anchor_samples = self._input_samples_sent
                self._input_offset_anchor_ms = offset_ms
            self._input_sequence = next_sequence
            self._input_samples_sent += len(payload) // 2
            self._input_last_offset_ms = next_offset_ms

    async def end_turn(self) -> None:
        """Commit the current push-to-talk turn."""
        if self._mode != "push_to_talk":
            raise RemoteVoiceError("end_turn is only available in push_to_talk mode")
        await self._send_json({"type": "turn.end"})

    async def interrupt(self) -> None:
        """Request interruption of the current assistant response."""
        await self._send_json({"type": "client.interrupt"})

    async def acknowledge_playout(self, commit_id: str) -> None:
        """Confirm an ``output.commit`` after the corresponding audio has played."""
        if not commit_id:
            raise ValueError("commit_id must not be empty")
        await self._send_json({"type": "output.playout_ack", "commitId": commit_id})

    async def events(self) -> AsyncIterator[RemoteVoiceEvent]:
        """Yield voice events and audio output until the session ends."""
        while True:
            event = await self._events.get()
            if event is None:
                if self._failure is not None:
                    raise self._failure
                return
            yield event

    async def close(self) -> None:
        """End the active session and release local reader and tool tasks."""
        if self._close_task is None:
            self._closed = True
            self._close_task = asyncio.create_task(self._finish_close())
        await asyncio.shield(self._close_task)

    async def _finish_close(self) -> None:
        if self._websocket.state.name == "OPEN":
            try:
                await asyncio.wait_for(
                    self._send_json({"type": "session.end"}),
                    timeout=_SESSION_END_SEND_TIMEOUT_SECONDS,
                )
            except (ConnectionClosed, RemoteVoiceError, asyncio.TimeoutError, TimeoutError):
                pass
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            await asyncio.gather(self._heartbeat_task, return_exceptions=True)
        if self._websocket.state.name == "OPEN":
            await self._websocket.close()
        await self._cancel_tool_tasks()
        if not self._reader_task.done():
            self._reader_task.cancel()
        await asyncio.gather(self._reader_task, return_exceptions=True)

    async def __aenter__(self) -> RemoteVoiceSession:
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        await self.close()

    async def _send(
        self,
        data: str | bytes,
        *,
        on_send_started: Callable[[], None] | None = None,
    ) -> None:
        if self._websocket.state.name != "OPEN":
            raise RemoteVoiceError("TVIC session is disconnected", code="connection_closed")
        async with self._send_lock:
            try:
                # A peer may reply after this frame is written but before send() finishes draining.
                if on_send_started is not None:
                    on_send_started()
                await self._websocket.send(data)
            except asyncio.CancelledError:
                if self._websocket.state.name == "OPEN":
                    await self._websocket.close(code=1011, reason="send cancelled")
                raise

    async def _send_json(
        self,
        value: Mapping[str, Any],
        *,
        on_send_started: Callable[[], None] | None = None,
    ) -> None:
        payload = _bounded_json_dumps(value, self._max_control_frame_bytes)
        await self._send(payload, on_send_started=on_send_started)

    async def _heartbeat(self) -> None:
        nonce = 0
        try:
            while not self._closed:
                await asyncio.sleep(5.0)
                nonce += 1
                await self._send_json({"type": "client.ping", "nonce": str(nonce)})
        except (asyncio.CancelledError, ConnectionClosed, RemoteVoiceError):
            return

    async def _read_loop(self) -> None:
        try:
            async for message in self._websocket:
                if self._failure is not None:
                    break
                if isinstance(message, bytes):
                    if not self._session_ready.done() or self._session_ready.cancelled():
                        raise RemoteVoiceProtocolError("audio output arrived before session.ready")
                    if self._session_ready.exception() is not None:
                        raise RemoteVoiceProtocolError("audio output arrived before session.ready")
                    self._handle_audio_output(message)
                else:
                    await self._handle_control(message)
                    if self._normal_end_received:
                        break
        except asyncio.CancelledError:
            raise
        except ConnectionClosed:
            pass
        except Exception as error:
            failure = (
                error
                if isinstance(error, RemoteVoiceError)
                else RemoteVoiceError("TVIC WebSocket reader failed", code="connection_failed")
            )
            self._record_failure(failure)
            try:
                is_protocol_error = isinstance(error, RemoteVoiceProtocolError)
                await self._websocket.close(
                    code=4400 if is_protocol_error else 1011,
                    reason="protocol error" if is_protocol_error else "runtime error",
                )
            except ConnectionClosed:
                pass
        finally:
            if not self._closed and not self._normal_end_received and self._failure is None:
                self._record_failure(
                    RemoteVoiceError(
                        "TVIC WebSocket closed before session.ended",
                        code="connection_closed",
                    )
                )
            if self._heartbeat_task is not None:
                self._heartbeat_task.cancel()
                await asyncio.gather(self._heartbeat_task, return_exceptions=True)
            if self._normal_end_received and self._websocket.state.name == "OPEN":
                close_code = 1011 if self._failure is not None else 1000
                try:
                    await self._websocket.close(code=close_code, reason="session ended")
                except ConnectionClosed:
                    pass
            await self._cancel_tool_tasks()
            if not self._session_ready.done():
                error = self._failure or RemoteVoiceError("TVIC connection closed before readiness")
                self._session_ready.set_exception(error)
            self._enqueue_end()

    async def _handle_control(self, raw: str) -> None:
        if self._failure is not None:
            return
        if len(raw.encode("utf-8")) > self._max_control_frame_bytes:
            raise RemoteVoiceProtocolError("worker control message exceeds the size limit")
        try:
            value = json.loads(raw)
        except (ValueError, RecursionError) as error:
            raise RemoteVoiceProtocolError("worker sent invalid JSON") from error
        if not isinstance(value, dict) or not isinstance(value.get("type"), str):
            raise RemoteVoiceProtocolError("worker message must be a JSON object with a type")
        if _contains_invalid_json_number(value):
            raise RemoteVoiceProtocolError(
                "worker message contains a non-finite number or an integer outside the JavaScript safe integer range"
            )

        message_type = value["type"]
        if (
            message_type not in ("agent.ready", "agent.error")
            and not self._session_start_send_started
        ):
            raise RemoteVoiceProtocolError(
                f"{message_type} arrived before session.start sending began"
            )
        if message_type == "agent.ready":
            self._handle_agent_ready(value)
        elif message_type == "agent.error":
            self._record_failure(
                RemoteVoiceError(
                    _error_message(value),
                    code=_string(value.get("code"), "session_start_failed"),
                )
            )
            raise self._failure or RemoteVoiceError("agent start failed")
        elif message_type == "session.ready":
            protocol_version = value.get("protocolVersion", _PROTOCOL_VERSION)
            if (
                not isinstance(protocol_version, int)
                or isinstance(protocol_version, bool)
                or protocol_version != _PROTOCOL_VERSION
            ):
                raise RemoteVoiceProtocolError("worker selected an unsupported protocol version")
            if self._session_id is None:
                raise RemoteVoiceProtocolError("session.ready arrived before agent.ready")
            if value.get("sessionId") != self._session_id:
                raise RemoteVoiceProtocolError("session.ready does not match agent.ready")
            if not self._session_ready.done():
                self._session_ready.set_result(None)
        elif message_type == "tool.call":
            if (
                not self._session_ready.done()
                or self._session_ready.cancelled()
                or self._session_ready.exception() is not None
            ):
                raise RemoteVoiceProtocolError("tool.call arrived before session.ready")
            await self._start_tool(value)
        elif message_type == "tool.cancel":
            tool_call_id = value.get("toolCallId")
            if isinstance(tool_call_id, str):
                task = self._tool_tasks.get(tool_call_id)
                if task is not None:
                    task.cancel()
        elif message_type == "voice.event":
            event = value.get("event")
            if not isinstance(event, dict) or not isinstance(event.get("kind"), str):
                raise RemoteVoiceProtocolError("voice.event has no event kind")
            self._enqueue(RemoteVoiceEvent(event["kind"], event))
        elif message_type == "voice.error":
            self._record_failure(
                RemoteVoiceError(
                    _error_message(value),
                    code=_string(value.get("code"), "session_failed"),
                )
            )
            raise self._failure or RemoteVoiceError("voice session failed")
        elif message_type in ("session.error", "session.ended", "server.pong"):
            if message_type == "session.error":
                self._record_failure(
                    RemoteVoiceProtocolError(
                        _error_message(value),
                        code=_string(value.get("code"), "protocol_error"),
                    )
                )
                raise self._failure or RemoteVoiceProtocolError("session protocol error")
            if message_type == "session.ended":
                self._normal_end_received = True
                if value.get("reason") == "failed":
                    self._record_failure(
                        RemoteVoiceError(
                            "TVIC session ended after a runtime failure",
                            code="session_failed",
                        )
                    )
        elif message_type in ("output.clear", "output.commit"):
            kind = "output_clear" if message_type == "output.clear" else "output_commit"
            self._output_sequence = 0
            self._enqueue(RemoteVoiceEvent(kind, value))
        elif message_type == "assistant.text":
            self._enqueue(RemoteVoiceEvent("assistant_text", value))
        else:
            raise RemoteVoiceProtocolError(f"unsupported worker message type: {message_type}")

    def _handle_agent_ready(self, value: Mapping[str, Any]) -> None:
        protocol_version = value.get("protocolVersion")
        if (
            not isinstance(protocol_version, int)
            or isinstance(protocol_version, bool)
            or protocol_version != _PROTOCOL_VERSION
        ):
            raise RemoteVoiceProtocolError("worker selected an unsupported protocol version")
        session_id = value.get("sessionId")
        call_id = value.get("callId")
        agent_id = value.get("agentId")
        if not all(isinstance(item, str) and item for item in (session_id, call_id, agent_id)):
            raise RemoteVoiceProtocolError("agent.ready is missing session identity")
        if agent_id != self._expected_agent_id:
            raise RemoteVoiceProtocolError("agent.ready does not match the requested agent")
        if value.get("audioFormat") != {
            "encoding": "pcm_s16le",
            "sampleRateHz": 16000,
            "channels": 1,
        }:
            raise RemoteVoiceProtocolError("worker selected an unsupported audio format")
        max_control_frame_bytes = value.get("maxControlFrameBytes")
        if (
            not isinstance(max_control_frame_bytes, int)
            or isinstance(max_control_frame_bytes, bool)
            or not 4_096 <= max_control_frame_bytes <= 65_536
        ):
            raise RemoteVoiceProtocolError("worker selected an invalid control frame limit")
        if self._session_id is not None:
            raise RemoteVoiceProtocolError("worker sent agent.ready more than once")
        self._session_id = session_id
        self._call_id = call_id
        self._agent_id = agent_id
        self._max_control_frame_bytes = max_control_frame_bytes
        self._schedule_send_json(
            {
                "type": "session.start",
                "protocolVersion": _PROTOCOL_VERSION,
                "mode": self._mode,
                "clientPlatform": self._client_platform,
                "audioFormat": {
                    "encoding": "pcm_s16le",
                    "sampleRateHz": 16000,
                    "channels": 1,
                },
            },
            on_send_started=lambda: setattr(self, "_session_start_send_started", True),
        )

    def _schedule_send_json(
        self,
        value: Mapping[str, Any],
        *,
        on_send_started: Callable[[], None] | None = None,
    ) -> None:
        async def send() -> None:
            await self._send_json(value, on_send_started=on_send_started)

        task = asyncio.create_task(send())
        task.add_done_callback(self._observe_send_task)

    def _observe_send_task(self, task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            self._close_for_failure(
                RemoteVoiceError("could not initialize the media session", code="connection_failed"),
                code=1011,
                reason="media session initialization failed",
            )

    def _handle_audio_output(self, frame: bytes) -> None:
        if len(frame) > _MAX_AUDIO_FRAME_BYTES or len(frame) < _AUDIO_HEADER.size + 2:
            raise RemoteVoiceProtocolError("invalid output audio frame size")
        version, flags, sequence, offset_ms, reserved = _AUDIO_HEADER.unpack_from(frame)
        payload = frame[_AUDIO_HEADER.size :]
        if version != 1 or flags != 0 or reserved != 0 or len(payload) % 2:
            raise RemoteVoiceProtocolError("invalid output audio frame header")
        if sequence != self._output_sequence + 1:
            raise RemoteVoiceProtocolError("output audio sequence is not contiguous")
        self._output_sequence = sequence
        self._enqueue(
            RemoteVoiceEvent(
                "audio_output",
                {
                    "sequence": sequence,
                    "monotonic_offset_ms": offset_ms,
                    "encoding": "pcm_s16le",
                    "sample_rate_hz": 16000,
                    "channels": 1,
                    "audio": payload,
                },
            )
        )

    async def _start_tool(self, message: Mapping[str, Any]) -> None:
        tool_call_id = message.get("toolCallId")
        tool_name = message.get("toolName")
        timeout_ms = message.get("timeoutMs")
        if not isinstance(tool_call_id, str) or not tool_call_id or not isinstance(tool_name, str):
            raise RemoteVoiceProtocolError("tool.call is missing its identity")
        if len(self._tool_tasks) >= _MAX_PENDING_TOOLS:
            self._close_for_failure(
                RemoteVoiceError("Python tool worker is at capacity", code="tool_capacity"),
                code=1013,
                reason="tool capacity exceeded",
            )
            return
        if tool_call_id in self._tool_tasks:
            raise RemoteVoiceProtocolError("worker reused an active tool call id")
        if (
            not isinstance(message.get("sessionId"), str)
            or not isinstance(message.get("turnId"), str)
            or not isinstance(message.get("idempotencyKey"), str)
            or not isinstance(message.get("attempt"), int)
            or isinstance(message.get("attempt"), bool)
            or message.get("attempt", 0) < 1
            or "input" not in message
            or message.get("sessionId") != self._session_id
            or (timeout_ms is not None and not _is_positive_finite_number(timeout_ms))
            or (message.get("tenant") is not None and not isinstance(message.get("tenant"), dict))
        ):
            raise RemoteVoiceProtocolError("tool.call has invalid execution context")
        task = asyncio.create_task(self._run_tool(message, tool_name, tool_call_id))
        self._tool_tasks[tool_call_id] = task
        task.add_done_callback(lambda completed: self._tool_task_done(tool_call_id, completed))

    async def _run_tool(
        self,
        message: Mapping[str, Any],
        tool_name: str,
        tool_call_id: str,
    ) -> None:
        handler = self._tools.get(tool_name)
        if handler is None:
            await self._send_tool_error(tool_call_id, f"no Python handler registered for {tool_name}")
            return
        session_id = message.get("sessionId")
        turn_id = message.get("turnId")
        idempotency_key = message.get("idempotencyKey")
        attempt = message.get("attempt")
        timeout_ms = message.get("timeoutMs")
        tenant = message.get("tenant")
        if (
            not isinstance(session_id, str)
            or not isinstance(turn_id, str)
            or not isinstance(idempotency_key, str)
            or not isinstance(attempt, int)
            or (tenant is not None and not isinstance(tenant, dict))
            or (timeout_ms is not None and not _is_positive_finite_number(timeout_ms))
        ):
            raise RemoteVoiceProtocolError("tool.call has invalid execution context")
        context = RemoteToolContext(
            session_id=session_id,
            turn_id=turn_id,
            tool_call_id=tool_call_id,
            idempotency_key=idempotency_key,
            attempt=attempt,
            timeout_ms=timeout_ms,
            tenant=tenant,
        )
        try:
            result = await _invoke_handler(handler, message.get("input"), context)
            await self._send_json(
                {"type": "tool.result", "toolCallId": tool_call_id, "output": result}
            )
        except asyncio.CancelledError:
            return
        except Exception as error:
            await self._send_tool_error(tool_call_id, str(error) or type(error).__name__)

    async def _send_tool_error(self, tool_call_id: str, message: str) -> None:
        bounded_message = message[:1_024]

        def error_payload(message_value: str) -> dict[str, Any]:
            return {
                "type": "tool.error",
                "toolCallId": tool_call_id,
                "error": {"message": message_value},
            }

        low = 0
        high = len(bounded_message)
        while low < high:
            candidate_length = (low + high + 1) // 2
            candidate = error_payload(bounded_message[:candidate_length])
            encoded_size = len(json.dumps(candidate, separators=(",", ":")).encode("utf-8"))
            if encoded_size <= self._max_control_frame_bytes:
                low = candidate_length
            else:
                high = candidate_length - 1

        payload = error_payload(bounded_message[:low])
        encoded_size = len(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
        if encoded_size > self._max_control_frame_bytes:
            self._close_for_failure(
                RemoteVoiceProtocolError("tool error exceeds the protocol size limit"),
                code=4400,
                reason="tool error exceeds the protocol size limit",
            )
            return

        try:
            await self._send_json(payload)
        except (ConnectionClosed, RemoteVoiceError):
            return

    def _enqueue(self, event: RemoteVoiceEvent) -> None:
        if self._events.full():
            self._close_for_failure(
                RemoteVoiceError("event queue exceeded its configured bound", code="backpressure"),
                code=1013,
                reason="client cannot keep up",
            )
            return
        self._events.put_nowait(event)

    def _close_for_failure(self, error: RemoteVoiceError, *, code: int, reason: str) -> None:
        self._record_failure(error)
        for task in tuple(self._tool_tasks.values()):
            task.cancel()
        if self._websocket.state.name == "OPEN":
            asyncio.create_task(self._websocket.close(code=code, reason=reason))

    def _enqueue_end(self) -> None:
        if self._end_enqueued:
            return
        self._end_enqueued = True
        if self._events.full():
            self._failure = RemoteVoiceError(
                "event queue exceeded its configured bound before session end",
                code="backpressure",
            )
            if not self._session_ready.done():
                self._session_ready.set_exception(self._failure)
            self._events.get_nowait()
        self._events.put_nowait(None)

    async def _cancel_tool_tasks(self) -> None:
        tasks = tuple(self._tool_tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=_TOOL_CLEANUP_TIMEOUT_SECONDS)

    def _tool_task_done(self, tool_call_id: str, task: asyncio.Task[None]) -> None:
        if self._tool_tasks.get(tool_call_id) is task:
            self._tool_tasks.pop(tool_call_id, None)
        if not task.cancelled():
            task.exception()

    def _record_failure(self, error: RemoteVoiceError) -> None:
        if self._failure is not None:
            return
        self._failure = error


async def _invoke_handler(
    handler: ToolHandler,
    inputs: Any,
    context: RemoteToolContext,
) -> Any:
    if inspect.iscoroutinefunction(handler):
        return await handler(inputs, context)
    if not _SYNC_TOOL_SLOTS.acquire(blocking=False):
        raise RemoteVoiceError(
            "Python synchronous tool capacity is exhausted",
            code="tool_capacity",
        )
    loop = asyncio.get_running_loop()
    try:
        future = _SYNC_TOOL_EXECUTOR.submit(handler, inputs, context)
    except BaseException:
        _SYNC_TOOL_SLOTS.release()
        raise
    future.add_done_callback(lambda _: _SYNC_TOOL_SLOTS.release())
    result = await asyncio.wrap_future(future, loop=loop)
    if inspect.isawaitable(result):
        return await result
    return result


def _normalize_endpoint(endpoint: str) -> str:
    parts = urlsplit(endpoint)
    scheme = {"http": "ws", "https": "wss"}.get(parts.scheme, parts.scheme)
    if scheme not in ("ws", "wss") or not parts.netloc or parts.query or parts.fragment:
        raise ValueError("endpoint must be a ws://, wss://, http://, or https:// URL without query or fragment")
    return urlunsplit((scheme, parts.netloc, parts.path.rstrip("/"), "", ""))


def _bounded_json_dumps(value: Any, max_bytes: int) -> str:
    """Serialize compact ASCII JSON within the frame byte and nesting bounds."""
    chunks: list[str] = []
    size = 0
    active_containers: set[int] = set()

    def append(chunk: str) -> None:
        nonlocal size
        chunk_size = len(chunk)
        if size + chunk_size > max_bytes:
            raise RemoteVoiceProtocolError("message exceeds the protocol size limit")
        chunks.append(chunk)
        size += chunk_size

    def append_string(value: str) -> None:
        append('"')
        for start in range(0, str.__len__(value), 256):
            chunk = str.__getitem__(value, slice(start, start + 256))
            escaped = json.dumps(chunk, ensure_ascii=True)[1:-1]
            append(escaped)
        append('"')

    def append_integer(value: int) -> str:
        integer_value = int.__index__(value)
        magnitude_bits = abs(integer_value).bit_length()
        minimum_decimal_digits = int((magnitude_bits - 1) * 0.3010299956639812) + 1
        if minimum_decimal_digits > max_bytes:
            raise RemoteVoiceProtocolError("message exceeds the protocol size limit")
        return str(integer_value)

    def append_value(item: Any, depth: int = 0) -> None:
        if item is None:
            append("null")
        elif item is True:
            append("true")
        elif item is False:
            append("false")
        elif isinstance(item, str):
            append_string(item)
        elif isinstance(item, int):
            integer_value = int.__index__(item)
            if (
                integer_value < -_MAX_SAFE_JSON_INTEGER
                or integer_value > _MAX_SAFE_JSON_INTEGER
            ):
                raise RemoteVoiceProtocolError(
                    "integer value exceeds the JavaScript safe integer range"
                )
            append(append_integer(integer_value))
        elif isinstance(item, float):
            float_value = float.__float__(item)
            if not math.isfinite(float_value):
                raise RemoteVoiceProtocolError("non-finite numbers cannot be sent over the protocol")
            if float_value.is_integer() and abs(float_value) > _MAX_SAFE_JSON_INTEGER:
                raise RemoteVoiceProtocolError(
                    "integer value exceeds the JavaScript safe integer range"
                )
            append(json.dumps(float_value, allow_nan=False))
        elif isinstance(item, (list, tuple)):
            if depth >= _MAX_JSON_CONTAINER_DEPTH:
                raise RemoteVoiceProtocolError("message exceeds the protocol nesting limit")
            identity = id(item)
            if identity in active_containers:
                raise ValueError("circular reference detected")
            active_containers.add(identity)
            try:
                append("[")
                for index, child in enumerate(item):
                    if index:
                        append(",")
                    append_value(child, depth + 1)
                append("]")
            finally:
                active_containers.remove(identity)
        elif isinstance(item, dict):
            if depth >= _MAX_JSON_CONTAINER_DEPTH:
                raise RemoteVoiceProtocolError("message exceeds the protocol nesting limit")
            identity = id(item)
            if identity in active_containers:
                raise ValueError("circular reference detected")
            active_containers.add(identity)
            try:
                append("{")
                serialized_keys: set[bytes] = set()
                for index, (key, child) in enumerate(item.items()):
                    if isinstance(key, str):
                        serialized_key = str.__getitem__(key, slice(None))
                    elif key is None:
                        serialized_key = "null"
                    elif key is True:
                        serialized_key = "true"
                    elif key is False:
                        serialized_key = "false"
                    elif isinstance(key, int):
                        serialized_key = append_integer(int.__index__(key))
                    elif isinstance(key, float):
                        serialized_key = json.dumps(float.__float__(key), allow_nan=False)
                    else:
                        raise TypeError("dictionary keys must be str, int, float, bool or None")
                    if index:
                        append(",")
                    append_string(serialized_key)
                    # JavaScript compares property names as UTF-16 code units;
                    # Python can represent a scalar and its surrogate pair separately.
                    property_identity = serialized_key.encode("utf-16-le", "surrogatepass")
                    if property_identity in serialized_keys:
                        raise RemoteVoiceProtocolError(
                            "dictionary keys serialize to duplicate JSON object properties"
                        )
                    serialized_keys.add(property_identity)
                    append(":")
                    append_value(child, depth + 1)
                append("}")
            finally:
                active_containers.remove(identity)
        else:
            raise TypeError(f"Object of type {type(item).__name__} is not JSON serializable")

    try:
        append_value(value)
    except RemoteVoiceProtocolError:
        raise
    except (TypeError, ValueError, RecursionError) as error:
        raise RemoteVoiceProtocolError("message is not JSON serializable") from error
    return "".join(chunks)


def _error_message(value: Mapping[str, Any]) -> str:
    message = value.get("message")
    return message[:1_024] if isinstance(message, str) else "TVIC session failed"


def _is_positive_finite_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value > 0
    return isinstance(value, float) and math.isfinite(value) and value > 0


def _contains_invalid_json_number(value: Any) -> bool:
    pending = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, bool) or item is None:
            continue
        if isinstance(item, int):
            if item < -_MAX_SAFE_JSON_INTEGER or item > _MAX_SAFE_JSON_INTEGER:
                return True
        elif isinstance(item, float):
            if not math.isfinite(item) or (
                item.is_integer() and abs(item) > _MAX_SAFE_JSON_INTEGER
            ):
                return True
        elif isinstance(item, list):
            pending.extend(item)
        elif isinstance(item, dict):
            pending.extend(item.values())
    return False


def _string(value: Any, default: str) -> str:
    return value if isinstance(value, str) and value else default
