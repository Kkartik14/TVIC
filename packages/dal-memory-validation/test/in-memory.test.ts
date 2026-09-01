import { describe, expect, it } from "vitest";
import { createInMemoryMemory } from "@tvic/dal";

import { memorySpecTest } from "../src/index.js";

describe("InMemoryMemory contract", () => {
  memorySpecTest(
    {
      name: "InMemoryMemory",
      createMemory: () => createInMemoryMemory(),
    },
    { expect, it },
  );
});
