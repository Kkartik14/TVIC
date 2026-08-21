const AUDIO_FORMAT = Object.freeze({ encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 });

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
  #outputEndTimes = new Map();
  #outputSources = new Set();
  #pendingCommits = new Map();
  #session;
  #closed = true;
  #lifecycle = 0;

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

  async connect() {
    if (!this.#options.gatewayUrl || !this.#options.appToken)
      throw new Error("gatewayUrl and appToken are required");
    if (this.connected) return;
    const lifecycle = ++this.#lifecycle;
    this.#closed = false;
    this.#inputSequence = 0;
    this.#inputStartedAt = 0;
    this.#nextPlaybackTime = 0;
    this.#outputEndTimes.clear();
    for (const commit of this.#pendingCommits.values()) clearTimeout(commit.timer);
    this.#pendingCommits.clear();
    this.#session = undefined;
    try {
      await this.#openAudio(lifecycle);
      const session = await this.#mintSession();
      if (lifecycle !== this.#lifecycle || this.#closed) throw new Error("Voice connection closed");
      this.#session = session;
      const socketUrl = new URL(
        this.#options.path.replace(":sessionRef", encodeURIComponent(session.sessionRef)),
        this.#options.gatewayUrl,
      );
      socketUrl.searchParams.set("token", session.token);
      socketUrl.searchParams.set("exp", String(session.expMs));
      const wsUrl = socketUrl.toString().replace(/^http/, "ws");
      await this.#openSocket(wsUrl, lifecycle);
      if (lifecycle !== this.#lifecycle || this.#closed) throw new Error("Voice connection closed");
      this.#socket.send(
        JSON.stringify({
          type: "session.start",
          protocolVersion: 1,
          mode: session.mode,
          clientPlatform: this.#options.clientPlatform,
          audioFormat: AUDIO_FORMAT,
        }),
      );
      this.#emit("connected", session);
    } catch (error) {
      if (lifecycle === this.#lifecycle) await this.close();
      throw error;
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

  async close() {
    this.#lifecycle += 1;
    this.#closed = true;
    this.#transmitting = false;
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
    for (const source of this.#outputSources) source.stop();
    this.#outputSources.clear();
    this.#outputEndTimes.clear();
    for (const commit of this.#pendingCommits.values()) clearTimeout(commit.timer);
    this.#pendingCommits.clear();
    this.#inputSequence = 0;
    this.#inputStartedAt = 0;
    this.#nextPlaybackTime = 0;
    this.#session = undefined;
    source?.disconnect();
    capture?.disconnect();
    gain?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    if (context) await context.close().catch(() => undefined);
    this.#emit("closed");
  }

  async #mintSession() {
    const response = await fetch(new URL("/v1/voice/session", this.#options.gatewayUrl), {
      method: "POST",
      mode: "cors",
      headers: {
        authorization: `Bearer ${this.#options.appToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: this.#options.mode }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Session mint failed (${response.status})`);
    return body;
  }

  async #openAudio(lifecycle) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("This browser does not support microphone capture");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
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
      await context.resume();
      await context.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
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

  #openSocket(url, lifecycle) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        if (lifecycle !== this.#lifecycle || this.#closed) {
          socket.close();
          reject(new Error("Voice connection closed"));
          return;
        }
        this.#socket = socket;
        resolve();
      };
      socket.onerror = () => {
        if (lifecycle === this.#lifecycle) reject(new Error("Voice WebSocket connection failed"));
      };
      socket.onclose = (event) => {
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
        this.#emit("error", new Error("Invalid server control frame"));
      }
      return;
    }
    const buffer = raw instanceof Blob ? await raw.arrayBuffer() : raw;
    if (lifecycle !== this.#lifecycle || this.#socket !== socket) return;
    this.#handleAudio(buffer);
  }

  #handleControl(message) {
    if (message.type === "session.ready") {
      const interval = Math.max(1000, Number(message.heartbeatIntervalMs) || 5000);
      this.#pingTimer = setInterval(
        () =>
          this.#socket?.send(JSON.stringify({ type: "client.ping", nonce: String(Date.now()) })),
        Math.max(1000, interval - 1000),
      );
      this.#emit("ready", message);
    } else if (message.type === "assistant.text") this.#emit("assistant-text", message);
    else if (message.type === "session.error")
      this.#emit("error", new Error(message.message ?? "Voice session error"));
    else if (message.type === "output.commit") this.#scheduleCommit(message);
    else if (message.type === "output.clear") this.#clearPlayback();
    else if (message.type === "server.pong") this.#emit("pong", message);
    else if (message.type === "session.ended") this.#emit("ended", message);
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
    this.#outputEndTimes.set(sequence, end);
    this.#outputSources.add(source);
    source.onended = () => this.#outputSources.delete(source);
    source.start(start);
    this.#emit("audio", { sequence, durationMs: audio.duration * 1000 });
  }

  #scheduleCommit(message) {
    const endSequence = Array.isArray(message.sequenceRange) ? Number(message.sequenceRange[1]) : 0;
    const commitId = String(message.commitId ?? "");
    if (!commitId) return;
    const endTime = this.#outputEndTimes.get(endSequence) ?? this.#nextPlaybackTime;
    const delay = Math.max(0, (endTime - (this.#context?.currentTime ?? 0)) * 1000);
    const timer = setTimeout(() => {
      if (!this.#closed)
        this.#socket?.send(JSON.stringify({ type: "output.playout_ack", commitId }));
      this.#pendingCommits.delete(commitId);
    }, delay + 25);
    this.#pendingCommits.set(commitId, { timer });
  }

  #clearPlayback() {
    for (const source of this.#outputSources) source.stop();
    this.#outputSources.clear();
    for (const commit of this.#pendingCommits.values()) clearTimeout(commit.timer);
    this.#pendingCommits.clear();
    this.#outputEndTimes.clear();
    this.#nextPlaybackTime = this.#context?.currentTime ?? 0;
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
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
    try {
      client = new TvicVoiceClient({
        gatewayUrl: gateway.value,
        appToken: token.value,
        mode: mode.value,
      });
      client.addEventListener("ready", () => {
        setStatus("Connected");
        enabled(true);
        if (client.mode === "continuous") client.startTurn();
      });
      client.addEventListener("assistant-text", (event) => {
        const text = event.detail.text ?? "";
        transcript.textContent += `${transcript.textContent ? "\n\n" : ""}${text}`;
      });
      client.addEventListener("error", (event) => setStatus(event.detail.message, true));
      client.addEventListener("ended", (event) =>
        setStatus(`Session ended: ${event.detail.reason}`),
      );
      client.addEventListener("closed", () => {
        enabled(false);
        setStatus("Disconnected");
      });
      await client.connect();
      setStatus("Connecting…");
    } catch (error) {
      setStatus(error.message, true);
      await client?.close();
    }
  });
  const press = (event) => {
    event.preventDefault();
    client?.startTurn();
  };
  const release = (event) => {
    event.preventDefault();
    if (client?.mode === "push_to_talk") client.endTurn();
  };
  talk.addEventListener("pointerdown", press);
  talk.addEventListener("pointerup", release);
  talk.addEventListener("pointercancel", release);
  talk.addEventListener("pointerleave", release);
  interrupt.addEventListener("click", () => client?.interrupt());
  disconnect.addEventListener("click", () => client?.close());
}
