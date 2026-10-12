import { createRemoteVoiceService } from "../../../../packages/voice-runtime/dist/index.js";

const service = createRemoteVoiceService({
  host: "127.0.0.1",
  port: 0,
  agents: [
    {
      id: "appointments",
      tools: [
        {
          id: "lookup_customer",
          name: "lookup_customer",
          description: "Looks up a customer by email.",
          inputSchema: { type: "object", required: ["email"] },
          outputSchema: { type: "object", required: ["found"] },
          timeout: { timeoutMs: 100.5, onTimeout: "fail" },
        },
      ],
      createAgent({ telephony, tools }) {
        return {
          id: "appointments",
          name: "Appointment test agent",
          prompt: "Test agent",
          providers: { telephony: "web-client-audio", stt: "fake", llm: "fake", tts: "fake" },
          async start(options) {
            const sessionId = "session_node_python_test";
            const callHandle = await options.callHandle({
              sessionId,
              call: options.call,
              channel: "web_audio",
              signal: options.signal,
            });
            const run = {
              async *[Symbol.asyncIterator]() {
                for await (const event of callHandle.events) {
                  if (event.type === "media.stream.started") break;
                }
                const tool = tools[0];
                if (!tool) throw new Error("remote tool was not registered");
                const output = await tool.execute(
                  { email: "person@example.com" },
                  {
                    sessionId,
                    turnId: "turn_node_python_test",
                    toolCallId: "tool_node_python_test",
                    attempt: 1,
                    signal: options.signal,
                    logger: { debug() {}, info() {}, warn() {}, error() {} },
                  },
                );
                yield {
                  kind: "tool_result",
                  toolCallId: "tool_node_python_test",
                  output,
                  latencyMs: 1,
                };
                yield { kind: "call_ended", reason: "completed", totalTurns: 1 };
              },
            };
            return { sessionId, run };
          },
          async run() {
            throw new Error("not used");
          },
          async stop() {},
          async healthCheck() {
            return { ok: true };
          },
        };
      },
    },
  ],
});

await service.start();
process.stdout.write(`${JSON.stringify({ port: service.address.port })}\n`);

let stopping = false;
process.once("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  void service.stop().finally(() => process.exit(0));
});
