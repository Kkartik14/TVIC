import type { SpeechControlCatalogSnapshot } from "@tvic/core";

import {
  loadCartesiaVoiceControlSnapshot,
  type LoadCartesiaVoiceControlSnapshotOptions,
} from "./speech-control-catalog.js";
import { createProviderSpeechControlCatalogSnapshot } from "./speech-control-static-catalog.js";

export async function loadCartesiaSpeechControlCatalogSnapshot(
  options: LoadCartesiaVoiceControlSnapshotOptions,
): Promise<SpeechControlCatalogSnapshot> {
  const accountSnapshot = await loadCartesiaVoiceControlSnapshot(options);
  return createProviderSpeechControlCatalogSnapshot({
    fetchedAt: accountSnapshot.fetchedAt,
    validUntil: accountSnapshot.validUntil,
    accountSnapshots: [accountSnapshot],
  });
}
