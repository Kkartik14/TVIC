import { base64ToBytes, bytesToBase64, assertPcm16leFormat } from "@tvic/media";
import {
  PCM16_16K_MONO,
  PROVIDER_NAMES,
  isDtmfDigit,
  sameAudioFormat,
  TvicThrowableError,
  validationError,
  type AudioFormat,
} from "@tvic/core";

import { unknownErrorMessage } from "./common.js";

export function validateTwilioMessage(
  value: Readonly<Record<string, unknown>>,
  streamSid: string | null,
  lastSequenceNumber: number | null,
): string | null {
  const event = value.event;
  if (event === "connected") {
    if (streamSid !== null) return "connected frame arrived after stream start";
    if (value.protocol !== undefined && typeof value.protocol !== "string") {
      return "connected.protocol must be a string";
    }
    if (value.version !== undefined && typeof value.version !== "string") {
      return "connected.version must be a string";
    }
    return null;
  }

  if (
    event !== "start" &&
    event !== "media" &&
    event !== "dtmf" &&
    event !== "mark" &&
    event !== "stop"
  ) {
    return "unknown event type";
  }

  const messageStreamSid = nonEmptyString(value.streamSid);
  if (!messageStreamSid) return "streamSid is required";
  if (event === "start") {
    if (streamSid !== null) return "duplicate start frame";
  } else {
    if (streamSid === null) return "stream frame arrived before start";
    if (messageStreamSid !== streamSid) return "streamSid changed during the stream";
  }

  const sequence = strictSequence(value.sequenceNumber);
  if (sequence === null) return "sequenceNumber must be a positive decimal integer";
  if (lastSequenceNumber !== null && sequence <= lastSequenceNumber) {
    return "sequenceNumber must increase monotonically";
  }

  if (event === "start") {
    const start = optionalRecord(value.start);
    if (value.start !== undefined && !start) return "start must be an object";
    const nestedStreamSid = start && nonEmptyString(start.streamSid);
    if (start && start.streamSid !== undefined && !nestedStreamSid) {
      return "start.streamSid must be a non-empty string";
    }
    if (nestedStreamSid && nestedStreamSid !== messageStreamSid) {
      return "start.streamSid does not match streamSid";
    }
    if (start && (start.accountSid !== undefined || start.callSid !== undefined)) {
      if (start.accountSid !== undefined && !nonEmptyString(start.accountSid)) {
        return "start.accountSid must be a non-empty string";
      }
      if (start.callSid !== undefined && !nonEmptyString(start.callSid)) {
        return "start.callSid must be a non-empty string";
      }
    }
    if (start?.customParameters !== undefined) {
      const parameters = optionalRecord(start.customParameters);
      if (!parameters || Object.values(parameters).some((item) => typeof item !== "string")) {
        return "start.customParameters must contain only string values";
      }
    }
    return null;
  }

  if (event === "media") {
    const media = optionalRecord(value.media);
    if (!media) return "media must be an object";
    if (media.track !== "inbound" && media.track !== "outbound") {
      return "media.track must be inbound or outbound";
    }
    if (!strictSequence(media.chunk)) return "media.chunk must be a positive decimal integer";
    if (!nonNegativeSequence(media.timestamp)) {
      return "media.timestamp must be a non-negative decimal integer";
    }
    if (!isCanonicalBase64(media.payload)) return "media.payload must be non-empty base64";
    return null;
  }

  if (event === "dtmf") {
    const dtmf = optionalRecord(value.dtmf);
    if (!dtmf || !isDtmfDigit(typeof dtmf.digit === "string" ? dtmf.digit : undefined)) {
      return "dtmf.digit is invalid";
    }
    return null;
  }

  if (event === "mark") {
    const mark = optionalRecord(value.mark);
    if (!mark || !nonEmptyString(mark.name)) return "mark.name is required";
    return null;
  }

  const stop = optionalRecord(value.stop);
  if (value.stop !== undefined && !stop) return "stop must be an object";
  if (stop?.callSid !== undefined && !nonEmptyString(stop.callSid)) {
    return "stop.callSid must be a non-empty string";
  }
  return null;
}

export function numericSequence(value: string | undefined): number {
  return strictSequence(value) ?? 0;
}

export function assertTwilioBoundaryFormat(format: AudioFormat): void {
  try {
    assertPcm16leFormat(format);
  } catch (error) {
    throw TvicThrowableError.from(
      validationError("twilio.audio_format_invalid", unknownErrorMessage(error), {
        provider: PROVIDER_NAMES.twilio,
        metadata: { format },
      }),
    );
  }
  if (!sameAudioFormat(format, PCM16_16K_MONO)) {
    throw TvicThrowableError.from(
      validationError(
        "twilio.audio_format_invalid",
        `Twilio adapter boundary requires 16kHz PCM mono, received ${format.sampleRateHz}Hz`,
        { provider: PROVIDER_NAMES.twilio, metadata: { format } },
      ),
    );
  }
}

export function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (right.byteLength === 0) return left;
  if (left.byteLength === 0) return new Uint8Array(right);
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left);
  output.set(right, left.byteLength);
  return output;
}

function optionalRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strictSequence(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeSequence(value: unknown): number | null {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  try {
    return bytesToBase64(base64ToBytes(value)) === value;
  } catch {
    return false;
  }
}
