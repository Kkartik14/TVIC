import type { Brand } from "./branded.js";

export type AgentId = Brand<string, "AgentId">;
export type SessionId = Brand<string, "SessionId">;
export type CallId = Brand<string, "CallId">;
export type TurnId = Brand<string, "TurnId">;
export type ToolId = Brand<string, "ToolId">;
export type ToolName = Brand<string, "ToolName">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type MediaEventId = Brand<string, "MediaEventId">;
export type ProviderEventId = Brand<string, "ProviderEventId">;
export type MemoryEntryId = Brand<string, "MemoryEntryId">;
export type UserId = Brand<string, "UserId">;
export type OrganizationId = Brand<string, "OrganizationId">;
export type WorkflowId = Brand<string, "WorkflowId">;
