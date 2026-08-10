const vscode = require("vscode");

const DEBUG_TYPE = "vscode-agent-bridge-e2e";

exports.activate = function activate(context) {
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      createDebugAdapterDescriptor() {
        return new vscode.DebugAdapterInlineImplementation(new E2EDebugAdapter());
      },
    }),
  );
};

class E2EDebugAdapter {
  constructor() {
    this.messages = new vscode.EventEmitter();
    this.onDidSendMessage = this.messages.event;
    this.counter = "1";
    this.sequence = 1;
  }

  handleMessage(message) {
    if (!message || message.type !== "request" || typeof message.command !== "string") return;
    const requestSequence = typeof message.seq === "number" ? message.seq : 0;
    const command = message.command;
    const args = message.arguments && typeof message.arguments === "object" ? message.arguments : {};
    switch (command) {
      case "initialize":
        this.respond(requestSequence, command, {
          supportsConfigurationDoneRequest: true,
          supportsRestartRequest: true,
          supportsSetVariable: true,
          supportsTerminateRequest: true,
          supportsFunctionBreakpoints: true,
        });
        this.event("initialized");
        return;
      case "threads":
        this.respond(requestSequence, command, { threads: [{ id: 1, name: "E2E Main Thread" }] });
        return;
      case "stackTrace":
        this.respond(requestSequence, command, {
          stackFrames: [{
            id: 101,
            name: "bridgeE2EFrame",
            source: { name: "debug-e2e.ts", path: process.env.VSCODE_AGENT_BRIDGE_E2E_DEBUG_SOURCE },
            line: 1,
            column: 1,
          }],
          totalFrames: 1,
        });
        return;
      case "scopes":
        this.respond(requestSequence, command, {
          scopes: [{ name: "Locals", variablesReference: 201, expensive: false }],
        });
        return;
      case "variables":
        this.respond(requestSequence, command, {
          variables: [{
            name: "counter",
            value: this.counter,
            type: "number",
            evaluateName: "counter",
            variablesReference: 0,
          }],
        });
        return;
      case "evaluate":
        this.respond(requestSequence, command, {
          result: this.counter,
          type: "number",
          variablesReference: 0,
        });
        return;
      case "setVariable":
        if (typeof args.value === "string") this.counter = args.value;
        this.respond(requestSequence, command, {
          value: this.counter,
          type: "number",
          variablesReference: 0,
        });
        return;
      case "setBreakpoints": {
        const breakpoints = Array.isArray(args.breakpoints) ? args.breakpoints : [];
        this.respond(requestSequence, command, {
          breakpoints: breakpoints.map((breakpoint, index) => ({
            id: index + 1,
            verified: true,
            line: typeof breakpoint.line === "number" ? breakpoint.line : 1,
          })),
        });
        return;
      }
      case "setFunctionBreakpoints": {
        const breakpoints = Array.isArray(args.breakpoints) ? args.breakpoints : [];
        this.respond(requestSequence, command, {
          breakpoints: breakpoints.map((_, index) => ({ id: index + 100, verified: true })),
        });
        return;
      }
      case "setExceptionBreakpoints":
        this.respond(requestSequence, command, { breakpoints: [] });
        return;
      case "pause":
        this.respond(requestSequence, command);
        this.event("stopped", { reason: "pause", threadId: 1, allThreadsStopped: true });
        return;
      case "continue":
        this.respond(requestSequence, command, { allThreadsContinued: true });
        this.event("continued", { threadId: 1, allThreadsContinued: true });
        setTimeout(() => this.event("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true }), 50);
        return;
      case "next":
      case "stepIn":
      case "stepOut":
      case "restart":
        this.respond(requestSequence, command);
        setTimeout(() => this.event("stopped", { reason: "step", threadId: 1, allThreadsStopped: true }), 25);
        return;
      case "disconnect":
      case "terminate":
        this.respond(requestSequence, command);
        this.event("terminated");
        return;
      case "configurationDone":
      case "launch":
      case "attach":
        this.respond(requestSequence, command);
        if (command === "configurationDone") {
          this.event("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true });
        }
        return;
      default:
        this.messages.fire({
          seq: this.sequence++,
          type: "response",
          request_seq: requestSequence,
          command,
          success: false,
          message: "Unsupported E2E adapter request",
        });
    }
  }

  respond(requestSequence, command, body = {}) {
    this.messages.fire({
      seq: this.sequence++,
      type: "response",
      request_seq: requestSequence,
      command,
      success: true,
      body,
    });
  }

  event(event, body = {}) {
    this.messages.fire({ seq: this.sequence++, type: "event", event, body });
  }

  dispose() {
    this.messages.dispose();
  }
}
