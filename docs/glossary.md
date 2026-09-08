# TVIC glossary

These are the terms used in the guides and API examples.

| Term              | Meaning                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Agent             | The reusable instructions, providers, tools, and runtime settings for one voice assistant.                                               |
| Barge-in          | The caller starts speaking while the agent is speaking. TVIC can stop the current response and clear queued audio.                       |
| CallHandle        | The connection object that lets TVIC read caller audio and send agent audio. Your transport creates it after authentication.             |
| Cascaded pipeline | A voice design where one stage passes its result to the next: speech to text, then the language model, then text to speech.              |
| Durable store     | Storage that survives a process restart, such as PostgreSQL. An in-memory store is lost when the process stops.                          |
| Endpointing       | Deciding that the caller has finished a turn. A final piece of transcript text does not always mean the caller has stopped speaking.     |
| Event             | A notification about something that happened, such as new transcript text, generated audio, a tool call, or an error.                    |
| LLM               | Large language model. TVIC uses it to decide what the agent should say and which available tool it should call.                          |
| Media             | The audio bytes moving between the caller, the transport, and the voice providers.                                                       |
| Playout           | The point at which output audio has actually been played to the caller, rather than only accepted by a server or sent over a connection. |
| Provider          | A service or implementation that performs one part of the voice pipeline, such as speech recognition or audio generation.                |
| STT               | Speech to text. It turns the caller's audio into written words.                                                                          |
| TTS               | Text to speech. It turns the agent's written response into audio.                                                                        |
| Tool              | An application-owned function the agent may ask to run, such as checking a calendar or booking an appointment.                           |
| Transport         | The connection that carries audio into and out of TVIC, such as browser audio or Twilio Media Streams.                                   |
| VAD               | Voice activity detection. A signal that someone has started or stopped speaking.                                                         |
| WebSocket         | A long-lived two-way connection used to exchange audio and events while a session is active.                                             |
| Webhook           | An HTTP request sent by a service, such as Twilio, to notify your application about an incoming call or event.                           |

For provider maturity, `stable` means the transport path is supported for the
release. `experimental` means the contract is tested, but TVIC has not yet
completed enough live provider testing to make a broader reliability claim.
