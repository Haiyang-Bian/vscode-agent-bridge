import { z } from "zod";

export const AgentEditVisibilitySchema = z.enum([
  "focusFirst",
  "focusEach",
  "firstOnly",
  "off",
]);
export const WorkspaceOnboardingStateSchema = z.enum([
  "unconfigured",
  "enabled",
  "disabled",
]);
export const WorkspaceSetupFileKindSchema = z.enum([
  "settings",
  "launch",
  "tasks",
  "workspace",
]);
export const WorkspaceSetupFileStateSchema = z.enum(["missing", "present", "unreadable"]);

export const GetWorkspaceSetupParamsSchema = z
  .object({
    rootUri: z.string().min(1).optional(),
  })
  .strict();
export const GetWorkspaceSetupInputSchema = GetWorkspaceSetupParamsSchema.extend({
  instanceId: z.uuid().optional(),
}).strict();

export const WorkspaceSetupFileSchema = z
  .object({
    kind: WorkspaceSetupFileKindSchema,
    state: WorkspaceSetupFileStateSchema,
    uri: z.string().min(1).nullable(),
  })
  .strict();

export const WorkspaceSetupResultSchema = z
  .object({
    instanceId: z.uuid(),
    rootUri: z.string().min(1),
    workspaceKind: z.enum(["folder", "workspaceFile"]),
    trusted: z.boolean(),
    remoteName: z.string().nullable(),
    onboarding: WorkspaceOnboardingStateSchema,
    editVisibility: AgentEditVisibilitySchema,
    vscodeDirectory: z.enum(["missing", "present", "unreadable"]),
    files: z.array(WorkspaceSetupFileSchema).length(4),
  })
  .strict();

export type AgentEditVisibility = z.infer<typeof AgentEditVisibilitySchema>;
export type GetWorkspaceSetupParams = z.infer<typeof GetWorkspaceSetupParamsSchema>;
export type WorkspaceOnboardingState = z.infer<typeof WorkspaceOnboardingStateSchema>;
export type WorkspaceSetupResult = z.infer<typeof WorkspaceSetupResultSchema>;
