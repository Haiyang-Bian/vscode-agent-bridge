import { z } from "zod";

import {
  BRIDGE_CAPABILITIES,
  BRIDGE_ERROR_CODES,
  BRIDGE_PROTOCOL_VERSION,
} from "./constants.js";

export const PositionSchema = z
  .object({
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
  })
  .strict();

export const RangeSchema = z
  .object({
    start: PositionSchema,
    end: PositionSchema,
  })
  .strict();

export const SelectionSchema = z
  .object({
    anchor: PositionSchema,
    active: PositionSchema,
  })
  .strict();

export const WorkspaceFolderSchema = z
  .object({
    name: z.string(),
    uri: z.string().min(1),
    index: z.number().int().nonnegative(),
  })
  .strict();

export const EditorInfoSchema = z
  .object({
    uri: z.string().min(1),
    languageId: z.string(),
    documentVersion: z.number().int().nonnegative(),
    isDirty: z.boolean(),
    isUntitled: z.boolean(),
    eol: z.enum(["LF", "CRLF"]),
    viewColumn: z.number().int().positive().nullable(),
    selection: SelectionSchema,
    visibleRanges: z.array(RangeSchema),
  })
  .strict();

export const TransportDescriptorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("named-pipe"),
      endpoint: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unix-socket"),
      endpoint: z.string().min(1),
    })
    .strict(),
]);

export const InstanceDescriptorSchema = z
  .object({
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    appName: z.string().min(1),
    appHost: z.string().min(1),
    remoteName: z.string().nullable(),
    workspaceTrusted: z.boolean(),
    workspaceFolders: z.array(WorkspaceFolderSchema),
    transport: TransportDescriptorSchema,
    authToken: z.string().min(32),
  })
  .strict();

export const PublicInstanceSchema = InstanceDescriptorSchema.omit({
  authToken: true,
  transport: true,
}).extend({
  transportKind: z.enum(["named-pipe", "unix-socket"]),
});

export const EditorContextSchema = z
  .object({
    instanceId: z.string().uuid(),
    workspaceTrusted: z.boolean(),
    remoteName: z.string().nullable(),
    workspaceFolders: z.array(WorkspaceFolderSchema),
    activeEditor: EditorInfoSchema.nullable(),
    visibleEditors: z.array(EditorInfoSchema),
  })
  .strict();

export const BridgeInitializeParamsSchema = z
  .object({
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    authToken: z.string().min(32),
    client: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export const BridgeInitializeResultSchema = z
  .object({
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    instanceId: z.string().uuid(),
    capabilities: z.array(z.enum(BRIDGE_CAPABILITIES)),
  })
  .strict();

export const JsonRpcIdSchema = z.union([z.string(), z.number().int()]);

export const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .strict();

export const JsonRpcSuccessResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema,
    result: z.unknown(),
  })
  .strict();

export const JsonRpcErrorDataSchema = z
  .object({
    bridgeCode: z.enum(BRIDGE_ERROR_CODES),
    details: z.unknown().optional(),
  })
  .strict();

export const JsonRpcErrorResponseSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: JsonRpcIdSchema.nullable(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string(),
        data: JsonRpcErrorDataSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const JsonRpcResponseSchema = z.union([
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
]);

export type BridgeInitializeParams = z.infer<typeof BridgeInitializeParamsSchema>;
export type BridgeInitializeResult = z.infer<typeof BridgeInitializeResultSchema>;
export type EditorContext = z.infer<typeof EditorContextSchema>;
export type EditorInfo = z.infer<typeof EditorInfoSchema>;
export type InstanceDescriptor = z.infer<typeof InstanceDescriptorSchema>;
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;
export type PublicInstance = z.infer<typeof PublicInstanceSchema>;
export type TransportDescriptor = z.infer<typeof TransportDescriptorSchema>;
export type WorkspaceFolder = z.infer<typeof WorkspaceFolderSchema>;
