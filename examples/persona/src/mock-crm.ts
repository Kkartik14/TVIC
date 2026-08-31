/**
 * Mock CRM. The user replaces this with a real CRM call (Salesforce,
 * HubSpot, internal DB). The persona hook awaits `mockCrm()`; the
 * result is fed to the persona hook which composes the system prompt.
 */
import type { OrganizationId, UserId } from "@tvic/core";

export interface CrmRecord {
  readonly firstName: string;
  readonly lastName: string;
  readonly company: string;
  readonly accountId: string;
  readonly lastTopic: string;
}

const MOCK: Record<string, CrmRecord> = {
  "ada@acme": {
    firstName: "Ada",
    lastName: "Lovelace",
    company: "Acme Corp",
    accountId: "ACC-001",
    lastTopic: "billing question",
  },
  "bob@globex": {
    firstName: "Bob",
    lastName: "Loblaw",
    company: "Globex Industries",
    accountId: "ACC-002",
    lastTopic: "product return",
  },
};

export async function mockCrm(
  userId: UserId | undefined,
  organizationId: OrganizationId | undefined,
): Promise<CrmRecord | null> {
  if (!userId || !organizationId) return null;
  const key = `${userId}@${organizationId}`.toLowerCase();
  return MOCK[key] ?? null;
}
