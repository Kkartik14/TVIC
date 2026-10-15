import { describe, expect, it } from "vitest";

import type { SessionId } from "@tvic/core";
import { AttachmentAdmission } from "../src/attachment-admission.js";

describe("AttachmentAdmission", () => {
  it("keeps one owner's admission hold until that owner releases it", () => {
    const admission = new AttachmentAdmission();
    const sessionId = "session_admission" as SessionId;
    const releaseFirst = admission.acquire(sessionId);
    const releaseSecond = admission.acquire(sessionId);

    releaseFirst();
    expect(admission.has(sessionId)).toBe(true);

    releaseSecond();
    expect(admission.has(sessionId)).toBe(false);

    releaseFirst();
    expect(admission.has(sessionId)).toBe(false);
  });
});
