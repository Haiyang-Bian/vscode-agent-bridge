import type { AgentEditVisibility } from "@vscode-agent-bridge/protocol";

export interface EditorRevealStep<Target> {
  readonly target: Target;
  readonly preserveFocus: boolean;
}

export function planEditorReveal<Target>(
  policy: AgentEditVisibility,
  targets: readonly Target[],
): EditorRevealStep<Target>[] {
  if (targets.length === 0 || policy === "off") {
    return [];
  }
  if (policy === "firstOnly") {
    return [{ target: targets[0]!, preserveFocus: false }];
  }
  if (policy === "focusEach") {
    return targets.map((target) => ({ target, preserveFocus: false }));
  }
  return [
    ...targets.slice(1).map((target) => ({ target, preserveFocus: true })),
    { target: targets[0]!, preserveFocus: false },
  ];
}
