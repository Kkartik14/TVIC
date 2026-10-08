import { bindHoldToTalkButton } from "./hold-to-talk.js";

const AUDIO_FORMAT = Object.freeze({ encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 });
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const MIN_HEARTBEAT_INTERVAL_MS = 100;
const MAX_HEARTBEAT_INTERVAL_MS = 60000;

export function encodePcmFrame(samples, sequence, offsetMs) {
  if (!(samples instanceof Int16Array) || sequence < 1 || !Number.isInteger(sequence)) {
    throw new Error("Invalid PCM frame");
  }
  const frame = new ArrayBuffer(12 + samples.byteLength);
  const view = new DataView(frame);
  view.setUint8(0, 1);
  view.setUint8(1, 0);
  view.setUint32(2, sequence, true);
  view.setUint32(6, Math.max(0, Math.floor(offsetMs)), true);
  view.setUint16(10, 0, true);
  new Int16Array(frame, 12).set(samples);
  return frame;
}

export function decodePcmFrame(buffer) {
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength < 12 ||
    (buffer.byteLength - 12) % 2 !== 0
  ) {
    return null;
  }
  const view = new DataView(buffer);
  if (view.getUint8(0) !== 1 || view.getUint8(1) !== 0 || view.getUint16(10, true) !== 0) {
    return null;
  }
  return {
    sequence: view.getUint32(2, true),
    offsetMs: view.getUint32(6, true),
    samples: new Int16Array(buffer.slice(12)),
  };
}

export class TvicVoiceClient extends EventTarget {
  #options;
  #socket;
  #pendingSocket;
  #connectController;
  #stream;
  #context;
  #source;
  #capture;
  #gain;
  #pingTimer;
  #inputSequence = 0;
  #inputStartedAt = 0;
  #transmitting = false;
  #nextPlaybackTime = 0;
  #outputSourcesBySequence = new Map();
  #outputSources = new Set();
  #completedOutputSources = new WeakSet();
  #pendingCommits = new Map();
  #session;
  #lastSessionRef;
  #lastEndReason;
  #lastError;
  #closed = true;
  #lifecycle = 0;
  #closePromise;

  constructor(options) {
    super();
    this.#options = {
      path: "/voice/:sessionRef",
      clientPlatform: "tvic-browser-client",
      ...options,
    };
  }

  get connected() {
    return Boolean(this.#socket && this.#socket.readyState === WebSocket.OPEN);
  }
  get mode() {
    return this.#session?.mode ?? this.#options.mode;
  }

  get lastSessionRef() {
    return this.#lastSessionRef;
  }

  get lastEndReason() {
    return this.#lastEndReason;
  }

  get lastError() {
    return this.#lastError;
  }

  async connect(options = {}) {
    if (!this.#options.gatewayUrl || !this.#options.appToken)
      throw new Error("gatewayUrl and appToken are required");
    if (this.connected) return;
    if (this.#connectController && !this.#connectController.signal.aborted) {
      throw new Error("Voice connection is already in progress");
    }
    const lifecycle = ++this.#lifecycle;
    this.#closePromise = undefined;
    const controller = new AbortController();
    this.#connectController = controller;
    this.#closed = false;
    this.#inputSequence = 0;
    this.#inputStartedAt = 0;
    this.#nextPlaybackTime = 0;
    this.#cancelPlayback();
    this.#lastEndReason = undefined;
    this.#lastError = undefined;
    this.#session = undefined;
    try {
      await this.#openAudio(lifecycle, controller.signal);
      const session = await this.#mintSession(options.supersedes, controller.signal);
      this.#lastSessionRef = session.sessionRef;
      if (lifecycle !== this.#lifecycle || this.#closed || controller.signal.aborted)
        throw new Error("Voice connection closed");
      this.#session = session;
      const socketUrl = new URL(
        this.#options.path.replace(":sessionRef", encodeURIComponent(session.sessionRef)),
        this.#options.gatewayUrl,
      );
      socketUrl.searchParams.set("token", session.token);
      socketUrl.searchParams.set("exp", String(session.expMs));
      const wsUrl = socketUrl.toString().replace(/^http/, "ws");
      await this.#openSocket(wsUrl, lifecycle, controller.signal);
      if (lifecycle !== this.#lifecycle || this.#closed || controller.signal.aborted)
        throw new Error("Voice connection closed");
      this.#socket.send(
        JSON.stringify({
          type: "session.start",
          protocolVersion: 1,
          mode: session.mode,
          clientPlatform: this.#options.clientPlatform,
          audioFormat: AUDIO_FORMAT,
        }),
      );
      this.#emit("connected", {
        sessionRef: session.sessionRef,
        expMs: session.expMs,
        mode: session.mode,
      });
    } catch (error) {
      if (lifecycle === this.#lifecycle) await this.close();
      throw error;
    } finally {
      if (this.#connectController === controller) this.#connectController = undefined;
    }
  }

  startTurn() {
    if (!this.connected) throw new Error("Voice client is not connected");
    this.#transmitting = true;
    if (!this.#inputStartedAt) this.#inputStartedAt = performance.now();
    this.#emit("transmitting", true);
  }

  endTurn() {
    if (!this.connected) return;
    this.#transmitting = false;
    if (this.mode === "push_to_talk") this.#socket.send(JSON.stringify({ type: "turn.end" }));
    this.#emit("transmitting", false);
  }

  interrupt() {
    if (this.connected) this.#socket.send(JSON.stringify({ type: "client.interrupt" }));
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    const closing = this.#closeCurrentLifecycle();
    this.#closePromise = closing;
    return closing;
  }

  async #closeCurrentLifecycle() {
    const lifecycle = ++this.#lifecycle;
    this.#closed = true;
    this.#transmitting = false;
    const controller = this.#connectController;
    this.#connectController = undefined;
    controller?.abort();
    const pendingSocket = this.#pendingSocket;
    this.#pendingSocket = undefined;
    pendingSocket?.close(1000, "client closed");
    const socket = this.#socket;
    const source = this.#source;
    const capture = this.#capture;
    const gain = this.#gain;
    const stream = this.#stream;
    const context = this.#context;
    this.#socket = undefined;
    this.#source = undefined;
    this.#capture = undefined;
    this.#gain = undefined;
    this.#stream = undefined;
    this.#context = undefined;
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
    if (socket && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: "session.end" }));
    socket?.close(1000, "client closed");
    this.#cancelPlayback();
    this.#inputSequence = 0;
    this.#inputStartedAt = 0;
    this.#nextPlaybackTime = 0;
    this.#session = undefined;
    source?.disconnect();
    capture?.disconnect();
    gain?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    if (context) await context.close().catch(() => undefined);
    if (lifecycle === this.#lifecycle) this.#emit("closed");
  }

  async #mintSession(supersedes, signal) {
    const mint = async (priorSessionRef) => {
      const response = await waitForAbort(
        fetch(new URL("/v1/voice/session", this.#options.gatewayUrl), {
          method: "POST",
          mode: "cors",
          signal,
          headers: {
            authorization: `Bearer ${this.#options.appToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            mode: this.#options.mode,
            ...(typeof priorSessionRef === "string" && priorSessionRef
              ? { supersedes: priorSessionRef }
              : {}),
          }),
        }),
        signal,
      );
      const body = await waitForAbort(
        response.json().catch(() => ({})),
        signal,
      );
      return { response, body };
    };

    let result = await mint(supersedes);
    if (
      !result.response.ok &&
      supersedes &&
      result.response.status === 403 &&
      result.body.error === "invalid_supersedes"
    ) {
      result = await mint(undefined);
    }
    if (!result.response.ok)
      throw new Error(result.body.error ?? `Session mint failed (${result.response.status})`);
    return result.body;
  }

  async #openAudio(lifecycle, signal) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("This browser does not support microphone capture");
    const pendingStream = navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const stream = await waitForAbort(pendingStream, signal, stopMediaStream);
    let context;
    let source;
    let capture;
    let gain;
    try {
      if (lifecycle !== this.#lifecycle || this.#closed)
        throw new Error("Voice audio setup cancelled");
      this.#stream = stream;
      context = new AudioContext();
      this.#context = context;
      await waitForAbort(context.resume(), signal);
      await waitForAbort(
        context.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url)),
        signal,
      );
      if (lifecycle !== this.#lifecycle || this.#closed)
        throw new Error("Voice audio setup cancelled");
      source = context.createMediaStreamSource(stream);
      this.#source = source;
      capture = new AudioWorkletNode(context, "tvic-pcm-capture");
      this.#capture = capture;
      capture.port.onmessage = (event) => {
        if (lifecycle === this.#lifecycle && !this.#closed) this.#sendAudio(event.data);
      };
      gain = context.createGain();
      this.#gain = gain;
      gain.gain.value = 0;
      source.connect(capture);
      capture.connect(gain);
      gain.connect(context.destination);
    } catch (error) {
      if (this.#source === source) this.#source = undefined;
      if (this.#capture === capture) this.#capture = undefined;
      if (this.#gain === gain) this.#gain = undefined;
      if (this.#stream === stream) this.#stream = undefined;
      if (this.#context === context) this.#context = undefined;
      source?.disconnect();
      capture?.disconnect();
      gain?.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      await context?.close().catch(() => undefined);
      if (signal.aborted) throw new Error("Voice audio setup cancelled");
      throw error;
    }
  }

  #sendAudio(raw) {
    if (!this.#transmitting || !this.connected) return;
    const samples = raw instanceof Int16Array ? raw : new Int16Array(raw);
    this.#socket.send(
      encodePcmFrame(samples, ++this.#inputSequence, performance.now() - this.#inputStartedAt),
    );
  }

  #openSocket(url, lifecycle, signal) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.#pendingSocket = socket;
      socket.binaryType = "arraybuffer";
      let settled = false;
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        if (this.#pendingSocket === socket) this.#pendingSocket = undefined;
        rejectOnce(new Error("Voice connection closed"));
        socket.close(1000, "client closed");
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      socket.onopen = () => {
        if (lifecycle !== this.#lifecycle || this.#closed || signal.aborted) {
          if (this.#pendingSocket === socket) this.#pendingSocket = undefined;
          socket.close();
          rejectOnce(new Error("Voice connection closed"));
          return;
        }
        settled = true;
        cleanup();
        this.#pendingSocket = undefined;
        this.#socket = socket;
        resolve();
      };
      socket.onerror = () => {
        if (lifecycle === this.#lifecycle)
          rejectOnce(new Error("Voice WebSocket connection failed"));
      };
      socket.onclose = (event) => {
        if (!settled) {
          if (this.#pendingSocket === socket) this.#pendingSocket = undefined;
          rejectOnce(new Error("Voice WebSocket closed before opening"));
          return;
        }
        if (this.#socket !== socket) return;
        this.#emit("transport-closed", event);
        if (!this.#closed) void this.close();
      };
      socket.onmessage = (event) => {
        if (this.#socket === socket) void this.#handleMessage(event.data, lifecycle, socket);
      };
    });
  }

  async #handleMessage(raw, lifecycle, socket) {
    if (lifecycle !== this.#lifecycle || this.#socket !== socket) return;
    if (typeof raw !== "string" && !(raw instanceof ArrayBuffer) && !(raw instanceof Blob)) return;
    if (typeof raw === "string") {
      try {
        this.#handleControl(JSON.parse(raw));
      } catch {
        this.#emitError(new Error("Invalid server control frame"));
      }
      return;
    }
    const buffer = raw instanceof Blob ? await raw.arrayBuffer() : raw;
    if (lifecycle !== this.#lifecycle || this.#socket !== socket) return;
    this.#handleAudio(buffer);
  }

  #handleControl(message) {
    if (message.type === "session.ready") {
      const configuredInterval = Number(message.heartbeatIntervalMs);
      const interval =
        Number.isSafeInteger(configuredInterval) &&
        configuredInterval >= MIN_HEARTBEAT_INTERVAL_MS &&
        configuredInterval <= MAX_HEARTBEAT_INTERVAL_MS
          ? configuredInterval
          : DEFAULT_HEARTBEAT_INTERVAL_MS;
      this.#pingTimer = setInterval(
        () =>
          this.#socket?.send(JSON.stringify({ type: "client.ping", nonce: String(Date.now()) })),
        interval,
      );
      this.#emit("ready", message);
    } else if (message.type === "assistant.text") this.#emit("assistant-text", message);
    else if (message.type === "session.error") {
      const error = new Error(message.message ?? "Voice session error");
      if (typeof message.code === "string") error.code = message.code;
      this.#emitError(error);
    } else if (message.type === "output.commit") this.#scheduleCommit(message);
    else if (message.type === "output.clear") this.#clearPlayback();
    else if (message.type === "server.pong") this.#emit("pong", message);
    else if (message.type === "session.ended") {
      this.#lastEndReason = typeof message.reason === "string" ? message.reason : "unknown";
      this.#emit("ended", { type: message.type, reason: this.#lastEndReason });
    }
  }

  #handleAudio(buffer) {
    const decoded = decodePcmFrame(buffer);
    if (!decoded) return;
    const { sequence, samples: payload } = decoded;
    if (!this.#context) return;
    const audio = this.#context.createBuffer(1, payload.length, 16000);
    const channel = audio.getChannelData(0);
    for (let i = 0; i < payload.length; i += 1) channel[i] = payload[i] / 32768;
    const source = this.#context.createBufferSource();
    source.buffer = audio;
    source.connect(this.#context.destination);
    const start = Math.max(this.#context.currentTime + 0.02, this.#nextPlaybackTime);
    const end = start + audio.duration;
    this.#nextPlaybackTime = end;
    const lifecycle = this.#lifecycle;
    this.#outputSourcesBySequence.set(sequence, source);
    this.#outputSources.add(source);
    source.onended = () => {
      this.#outputSources.delete(source);
      if (lifecycle !== this.#lifecycle || this.#closed) return;
      this.#completedOutputSources.add(source);
      for (const [commitId, commit] of this.#pendingCommits) {
        if (commit.source !== source) continue;
        this.#pendingCommits.delete(commitId);
        this.#sendPlayoutAck(commitId, lifecycle);
      }
    };
    source.start(start);
    this.#emit("audio", { sequence, durationMs: audio.duration * 1000 });
  }

  #scheduleCommit(message) {
    const range = message.sequenceRange;
    const [startSequence, endSequence] = Array.isArray(range) ? range : [];
    const commitId = message.commitId;
    if (
      typeof commitId !== "string" ||
      !commitId ||
      this.#pendingCommits.has(commitId) ||
      !Number.isSafeInteger(startSequence) ||
      !Number.isSafeInteger(endSequence) ||
      startSequence < 1 ||
      endSequence < startSequence ||
      endSequence - startSequence + 1 > this.#outputSourcesBySequence.size
    ) {
      return;
    }

    let finalSource;
    for (let sequence = startSequence; sequence <= endSequence; sequence += 1) {
      const source = this.#outputSourcesBySequence.get(sequence);
      if (!source) return;
      if (sequence === endSequence) finalSource = source;
    }
    if (!finalSource) return;
    for (let sequence = startSequence; sequence <= endSequence; sequence += 1) {
      this.#outputSourcesBySequence.delete(sequence);
    }
    if (this.#completedOutputSources.has(finalSource)) {
      this.#sendPlayoutAck(commitId, this.#lifecycle);
      return;
    }
    this.#pendingCommits.set(commitId, { source: finalSource });
  }

  #clearPlayback() {
    this.#cancelPlayback();
    this.#nextPlaybackTime = this.#context?.currentTime ?? 0;
  }

  #cancelPlayback() {
    for (const source of this.#outputSources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // A source can finish between iteration and stop.
      }
    }
    this.#outputSources.clear();
    this.#outputSourcesBySequence.clear();
    this.#pendingCommits.clear();
  }

  #sendPlayoutAck(commitId, lifecycle) {
    if (lifecycle !== this.#lifecycle || this.#closed) return;
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "output.playout_ack", commitId }));
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #emitError(error) {
    this.#lastError = error;
    this.#emit("error", error);
  }
}

function waitForAbort(promise, signal, onLateValue) {
  if (signal.aborted) {
    Promise.resolve(promise).then(onLateValue, () => undefined);
    return Promise.reject(new Error("Voice connection closed"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      settled = true;
      cleanup();
      reject(new Error("Voice connection closed"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        if (settled) {
          onLateValue?.(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function stopMediaStream(stream) {
  stream.getTracks().forEach((track) => track.stop());
}

if (typeof document !== "undefined" && document.querySelector("#connect")) {
  const gateway = document.querySelector("#gateway");
  const token = document.querySelector("#token");
  const mode = document.querySelector("#mode");
  const status = document.querySelector("#status");
  const transcript = document.querySelector("#transcript");
  const connect = document.querySelector("#connect");
  const talk = document.querySelector("#talk");
  const interrupt = document.querySelector("#interrupt");
  const disconnect = document.querySelector("#disconnect");
  gateway.value = location.origin;
  let client;
  let previousSessionRef;
  let connecting = false;
  const setStatus = (value, error = false) => {
    status.textContent = value;
    status.classList.toggle("error", error);
  };
  const enabled = (value) => {
    talk.disabled = !value;
    interrupt.disabled = !value;
    disconnect.disabled = !value;
    connect.disabled = value;
  };
  connect.addEventListener("click", async () => {
    if (connecting) return;
    connecting = true;
    connect.disabled = true;
    const nextClient = new TvicVoiceClient({
      gatewayUrl: gateway.value,
      appToken: token.value,
      mode: mode.value,
    });
    client = nextClient;
    try {
      nextClient.addEventListener("ready", () => {
        previousSessionRef = nextClient.lastSessionRef ?? previousSessionRef;
        connecting = false;
        setStatus("Connected");
        enabled(true);
        if (nextClient.mode === "continuous") nextClient.startTurn();
      });
      nextClient.addEventListener("assistant-text", (event) => {
        const text = event.detail.text ?? "";
        transcript.textContent += `${transcript.textContent ? "\n\n" : ""}${text}`;
      });
      nextClient.addEventListener("error", (event) => setStatus(event.detail.message, true));
      nextClient.addEventListener("ended", (event) => {
        previousSessionRef = nextClient.lastSessionRef ?? previousSessionRef;
        setStatus(`Session ended: ${event.detail.reason}`);
      });
      nextClient.addEventListener("closed", () => {
        if (client !== nextClient) return;
        previousSessionRef = nextClient.lastSessionRef ?? previousSessionRef;
        connecting = false;
        enabled(false);
        const endReason = nextClient.lastEndReason;
        const error = nextClient.lastError;
        if (endReason) setStatus(`Session ended: ${endReason}`);
        else if (error) setStatus(error.message, true);
        else setStatus("Disconnected");
      });
      await nextClient.connect(previousSessionRef ? { supersedes: previousSessionRef } : {});
      previousSessionRef = nextClient.lastSessionRef ?? previousSessionRef;
      setStatus("Connecting…");
    } catch (error) {
      previousSessionRef = nextClient.lastSessionRef ?? previousSessionRef;
      await nextClient.close();
      if (client === nextClient) {
        connecting = false;
        enabled(false);
        setStatus(error.message, true);
      }
    }
  });
  bindHoldToTalkButton(talk, () => client);
  interrupt.addEventListener("click", () => client?.interrupt());
  disconnect.addEventListener("click", () => client?.close());
}
