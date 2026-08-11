import { z } from "zod";

import {
  BRIDGE_CAPABILITIES,
  BRIDGE_ERROR_CODES,
  BRIDGE_PROTOCOL_VERSION,
  DEFAULT_DOCUMENT_MAX_CHARACTERS,
  DEFAULT_HOVER_MAX_CHARACTERS,
  DEFAULT_RESULT_LIMIT,
  MAX_DOCUMENT_CHARACTERS,
  MAX_HOVER_CHARACTERS,
  MAX_RESULT_LIMIT,
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

export const BridgeLifecycleSchema = z.enum(["initializing", "ready", "degraded"]);

export const InstanceDescriptorEnvelopeSchema = z
  .object({
    protocolVersion: z.number().int().positive(),
    extensionVersion: z.string().min(1),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    appName: z.string().min(1),
    appHost: z.string().min(1),
    remoteName: z.string().nullable(),
    workspaceTrusted: z.boolean(),
    lifecycle: BridgeLifecycleSchema,
    workspaceFolders: z.array(WorkspaceFolderSchema),
    transport: TransportDescriptorSchema,
    authToken: z.string().min(1),
  })
  .passthrough();

export const InstanceDescriptorSchema = z
  .object({
    protocolVersion: z.literal(BRIDGE_PROTOCOL_VERSION),
    extensionVersion: z.string().min(1),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    appName: z.string().min(1),
    appHost: z.string().min(1),
    remoteName: z.string().nullable(),
    workspaceTrusted: z.boolean(),
    lifecycle: BridgeLifecycleSchema,
    workspaceFolders: z.array(WorkspaceFolderSchema),
    transport: TransportDescriptorSchema,
    authToken: z.string().min(32),
  })
  .strict();

export const PublicInstanceSchema = z
  .object({
    protocolVersion: z.number().int().positive(),
    extensionVersion: z.string().min(1),
    instanceId: z.string().uuid(),
    pid: z.number().int().positive(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    appName: z.string().min(1),
    appHost: z.string().min(1),
    remoteName: z.string().nullable(),
    workspaceTrusted: z.boolean(),
    lifecycle: BridgeLifecycleSchema,
    workspaceFolders: z.array(WorkspaceFolderSchema),
    transportKind: z.enum(["named-pipe", "unix-socket"]),
    compatibility: z.enum(["current", "incompatible"]),
  })
  .strict();

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

const InstanceIdSchema = z.string().uuid();
const UriSchema = z.string().min(1);
export const DocumentAccessGrantIdSchema = z.uuid();

export const ReadDocumentParamsSchema = z
  .object({
    uri: UriSchema.optional(),
    accessGrantId: DocumentAccessGrantIdSchema.optional(),
    range: RangeSchema.optional(),
    maxChars: z
      .number()
      .int()
      .positive()
      .max(MAX_DOCUMENT_CHARACTERS)
      .default(DEFAULT_DOCUMENT_MAX_CHARACTERS),
  })
  .strict();

export const ReadDocumentInputSchema = ReadDocumentParamsSchema.extend({
  instanceId: InstanceIdSchema.optional(),
}).strict();

export const DocumentSnapshotSchema = z
  .object({
    instanceId: InstanceIdSchema,
    uri: UriSchema,
    languageId: z.string(),
    documentVersion: z.number().int().nonnegative(),
    isDirty: z.boolean(),
    isUntitled: z.boolean(),
    range: RangeSchema,
    text: z.string(),
    returnedCharacters: z.number().int().nonnegative(),
    totalCharacters: z.number().int().nonnegative(),
    truncated: z.boolean(),
    contentSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    capturedAt: z.string().min(1),
  })
  .strict();

export const DiagnosticSeveritySchema = z.enum(["error", "warning", "information", "hint"]);
export const DiagnosticTagSchema = z.enum(["unnecessary", "deprecated"]);

export const DiagnosticsParamsSchema = z
  .object({
    scope: z.enum(["active", "document", "workspace"]).default("active"),
    uri: UriSchema.optional(),
    workspaceFolderUri: UriSchema.optional(),
    severities: z.array(DiagnosticSeveritySchema).max(4).optional(),
    source: z.string().min(1).optional(),
    limit: z.number().int().positive().max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.scope === "document" && !value.uri) {
      context.addIssue({
        code: "custom",
        message: "uri is required when scope is document.",
        path: ["uri"],
      });
    }
    if (value.scope !== "document" && value.uri) {
      context.addIssue({
        code: "custom",
        message: "uri is only valid when scope is document.",
        path: ["uri"],
      });
    }
    if (value.scope !== "workspace" && value.workspaceFolderUri) {
      context.addIssue({
        code: "custom",
        message: "workspaceFolderUri is only valid when scope is workspace.",
        path: ["workspaceFolderUri"],
      });
    }
  });

export const DiagnosticsInputSchema = DiagnosticsParamsSchema.safeExtend({
  instanceId: InstanceIdSchema.optional(),
});

export const DiagnosticRelatedInformationSchema = z
  .object({
    uri: UriSchema,
    range: RangeSchema,
    message: z.string(),
  })
  .strict();

export const DiagnosticItemSchema = z
  .object({
    uri: UriSchema,
    range: RangeSchema,
    message: z.string(),
    severity: DiagnosticSeveritySchema,
    source: z.string().nullable(),
    code: z.string().nullable(),
    codeDescriptionUri: UriSchema.nullable(),
    tags: z.array(DiagnosticTagSchema),
    relatedInformation: z.array(DiagnosticRelatedInformationSchema),
  })
  .strict();

export const DiagnosticsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    scope: z.enum(["active", "document", "workspace"]),
    diagnostics: z.array(DiagnosticItemSchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const DocumentSymbolsParamsSchema = z
  .object({
    uri: UriSchema.optional(),
    accessGrantId: DocumentAccessGrantIdSchema.optional(),
    limit: z.number().int().positive().max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
  })
  .strict();

export const DocumentSymbolsInputSchema = DocumentSymbolsParamsSchema.extend({
  instanceId: InstanceIdSchema.optional(),
}).strict();

export const DocumentSymbolItemSchema = z
  .object({
    name: z.string(),
    detail: z.string().nullable(),
    kind: z.string().min(1),
    containerName: z.string().nullable(),
    depth: z.number().int().nonnegative(),
    range: RangeSchema,
    selectionRange: RangeSchema,
  })
  .strict();

export const DocumentSymbolsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    uri: UriSchema,
    symbols: z.array(DocumentSymbolItemSchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const PositionedDocumentParamsSchema = z
  .object({
    uri: UriSchema,
    accessGrantId: DocumentAccessGrantIdSchema.optional(),
    position: PositionSchema,
    limit: z.number().int().positive().max(MAX_RESULT_LIMIT).default(DEFAULT_RESULT_LIMIT),
  })
  .strict();

export const PositionedDocumentInputSchema = PositionedDocumentParamsSchema.extend({
  instanceId: InstanceIdSchema.optional(),
}).strict();

export const LocationItemSchema = z
  .object({
    uri: UriSchema,
    range: RangeSchema,
    accessGrantId: DocumentAccessGrantIdSchema.nullable(),
    accessGrantExpiresAt: z.string().min(1).nullable(),
  })
  .strict();

export const LocationsResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    uri: UriSchema,
    position: PositionSchema,
    locations: z.array(LocationItemSchema),
    returnedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export const HoverParamsSchema = z
  .object({
    uri: UriSchema,
    accessGrantId: DocumentAccessGrantIdSchema.optional(),
    position: PositionSchema,
    maxChars: z
      .number()
      .int()
      .positive()
      .max(MAX_HOVER_CHARACTERS)
      .default(DEFAULT_HOVER_MAX_CHARACTERS),
  })
  .strict();

export const HoverInputSchema = HoverParamsSchema.extend({
  instanceId: InstanceIdSchema.optional(),
}).strict();

export const HoverResultSchema = z
  .object({
    instanceId: InstanceIdSchema,
    uri: UriSchema,
    position: PositionSchema,
    range: RangeSchema.nullable(),
    contents: z.array(z.string()),
    returnedCharacters: z.number().int().nonnegative(),
    totalCharacters: z.number().int().nonnegative(),
    truncated: z.boolean(),
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
    lifecycle: BridgeLifecycleSchema,
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
export type BridgeLifecycle = z.infer<typeof BridgeLifecycleSchema>;
export type DiagnosticItem = z.infer<typeof DiagnosticItemSchema>;
export type DiagnosticsParams = z.infer<typeof DiagnosticsParamsSchema>;
export type DiagnosticsResult = z.infer<typeof DiagnosticsResultSchema>;
export type DocumentSnapshot = z.infer<typeof DocumentSnapshotSchema>;
export type DocumentSymbolItem = z.infer<typeof DocumentSymbolItemSchema>;
export type DocumentSymbolsParams = z.infer<typeof DocumentSymbolsParamsSchema>;
export type DocumentSymbolsResult = z.infer<typeof DocumentSymbolsResultSchema>;
export type EditorContext = z.infer<typeof EditorContextSchema>;
export type EditorInfo = z.infer<typeof EditorInfoSchema>;
export type HoverParams = z.infer<typeof HoverParamsSchema>;
export type HoverResult = z.infer<typeof HoverResultSchema>;
export type InstanceDescriptor = z.infer<typeof InstanceDescriptorSchema>;
export type InstanceDescriptorEnvelope = z.infer<typeof InstanceDescriptorEnvelopeSchema>;
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;
export type LocationItem = z.infer<typeof LocationItemSchema>;
export type LocationsResult = z.infer<typeof LocationsResultSchema>;
export type Position = z.infer<typeof PositionSchema>;
export type PositionedDocumentParams = z.infer<typeof PositionedDocumentParamsSchema>;
export type PublicInstance = z.infer<typeof PublicInstanceSchema>;
export type Range = z.infer<typeof RangeSchema>;
export type ReadDocumentParams = z.infer<typeof ReadDocumentParamsSchema>;
export type TransportDescriptor = z.infer<typeof TransportDescriptorSchema>;
export type WorkspaceFolder = z.infer<typeof WorkspaceFolderSchema>;
