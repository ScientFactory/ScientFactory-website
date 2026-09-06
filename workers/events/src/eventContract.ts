// Generated from scient-desktop/packages/scient-analytics/src/wireContract.ts. Do not edit here.
// Scient desktop wire contract. The website gateway consumes a generated copy.
export const PRIVACY_LEVELS = ["essential", "product", "diagnostic", "contribution"] as const;

export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

type PropertyRule =
  | { readonly kind: "integer"; readonly max: number; readonly optional?: boolean }
  | { readonly kind: "boolean"; readonly optional?: boolean }
  | { readonly kind: "enum"; readonly values: ReadonlyArray<string>; readonly optional?: boolean }
  | { readonly kind: "pattern"; readonly pattern: RegExp; readonly optional?: boolean };

interface EventDefinition {
  readonly privacyLevel: Exclude<PrivacyLevel, "contribution">;
  readonly properties: Readonly<Record<string, PropertyRule>>;
}

const provider = {
  kind: "enum",
  values: [
    "codex",
    "claudeAgent",
    "antigravity",
    "droid",
    "cursor",
    "grok",
    "opencode",
    "pi",
    "other",
  ],
} as const satisfies PropertyRule;
const runtimeMode = {
  kind: "enum",
  values: ["approval-required", "auto-accept-edits", "auto", "full-access", "other"],
} as const satisfies PropertyRule;
const durationBucket = {
  kind: "enum",
  values: ["under-1s", "1-5s", "5-15s", "15-60s", "1-3m", "3-10m", "over-10m", "unknown"],
} as const satisfies PropertyRule;
const countBucket = {
  kind: "enum",
  values: ["0", "1", "2-3", "4-10", "11-50", "over-50", "unknown"],
} as const satisfies PropertyRule;
const buildChannel = {
  kind: "enum",
  values: ["stable", "beta", "nightly", "development", "unknown"],
} as const satisfies PropertyRule;
const appVersion = {
  kind: "pattern",
  pattern:
    /^(?:unknown|\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:beta|nightly|rc|dev)(?:\.\d{1,14}){0,3})?)$/,
} as const satisfies PropertyRule;
const modelKey = {
  kind: "enum",
  values: [
    "auto",
    "claude-haiku-4-5",
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "composer-1.5",
    "composer-2",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "grok-build",
    "gemini-3.1-pro",
    "gemini-3.7-flash",
    "gemini-3.7-pro",
    "gemini-3.8-flash",
    "openai/gpt-5",
    "other",
    "unknown",
  ],
} as const satisfies PropertyRule;

const runtimeSource = {
  kind: "enum",
  values: ["custom", "system", "scient_managed", "missing", "unknown"],
} as const satisfies PropertyRule;
const providerState = {
  kind: "enum",
  values: ["ready", "warning", "error", "disabled", "unknown"],
} as const satisfies PropertyRule;
const failureClass = {
  kind: "enum",
  values: [
    "configuration",
    "authentication",
    "connection",
    "permission",
    "provider",
    "timeout",
    "filesystem",
    "checkpoint",
    "validation",
    "unavailable",
    "incompatible-version",
    "missing-dependency",
    "resource-exhaustion",
    "process-crash",
    "internal",
    "unknown",
  ],
} as const satisfies PropertyRule;
const lifecycleProperties = {
  provider,
  action: {
    kind: "enum",
    values: [
      "install",
      "update",
      "repair",
      "remove",
      "sign-in",
      "sign-out",
      "source-switch",
      "unknown",
    ],
  },
  runtimeSource,
  stage: {
    kind: "enum",
    values: [
      "preparing",
      "downloading",
      "verifying",
      "installing",
      "testing",
      "activating",
      "removing",
      "starting",
      "waiting_for_browser",
      "waiting_for_device_code",
      "queued",
      "running",
      "unknown",
    ],
  },
  failureClass,
  durationBucket,
} as const satisfies Readonly<Record<string, PropertyRule>>;
const operationProperties = {
  operationKind: {
    kind: "enum",
    values: [
      "file-preview",
      "pdf-open",
      "pdf-search",
      "pdf-export",
      "source-import",
      "browser",
      "chart-render",
      "math-render",
      "diagram-render",
      "compute-session",
      "compute-run",
      "compute-artifact",
      "latex-build",
      "document-export",
      "source-control",
      "built-in-skill",
      "worktree-provision",
      "thread-fork",
      "thread-revert",
      "turn-retry",
      "turn-steer",
      "queued-follow-up",
      "provider-handoff",
      "other",
    ],
  },
  trigger: { kind: "enum", values: ["user", "agent", "automation", "other"], optional: true },
  durationBucket: { ...durationBucket, optional: true },
  failureClass: { ...failureClass, optional: true },
  reviewRequired: { kind: "boolean", optional: true },
} as const satisfies Readonly<Record<string, PropertyRule>>;

export const EVENT_DEFINITIONS = {
  "app.health": {
    privacyLevel: "essential",
    properties: {
      component: {
        kind: "enum",
        values: ["desktop", "server", "renderer", "browser", "analytics", "unknown"],
      },
      operation: {
        kind: "enum",
        values: ["startup", "restart", "shutdown", "termination", "migration", "update", "unknown"],
      },
      outcome: { kind: "enum", values: ["started", "completed", "failed", "abnormal", "unknown"] },
      failureClass,
      durationBucket,
    },
  },
  "app.diagnostics": {
    privacyLevel: "diagnostic",
    properties: {
      queuedCountBucket: countBucket,
      droppedCountBucket: countBucket,
      retryCountBucket: countBucket,
      deliveryClass: {
        kind: "enum",
        values: ["idle", "delivered", "network", "timeout", "rejected", "unavailable", "unknown"],
      },
    },
  },
  "provider.discovered": {
    privacyLevel: "product",
    properties: { provider, runtimeSource, state: providerState },
  },
  "provider.readiness.changed": {
    privacyLevel: "product",
    properties: { provider, from: providerState, to: providerState },
  },
  "provider.runtime.source.changed": {
    privacyLevel: "product",
    properties: { provider, from: runtimeSource, to: runtimeSource },
  },
  "provider.lifecycle.started": { privacyLevel: "product", properties: lifecycleProperties },
  "provider.lifecycle.completed": { privacyLevel: "product", properties: lifecycleProperties },
  "provider.lifecycle.failed": { privacyLevel: "essential", properties: lifecycleProperties },
  "provider.lifecycle.cancelled": { privacyLevel: "product", properties: lifecycleProperties },
  "app.session.started": {
    privacyLevel: "essential",
    properties: {
      appVersion,
      buildChannel,
      platform: { kind: "enum", values: ["macos", "windows", "linux", "other"] },
      architecture: { kind: "enum", values: ["arm64", "x64", "other"] },
    },
  },
  "app.session.ended": {
    privacyLevel: "essential",
    properties: {
      durationBucket,
      shutdownClass: { kind: "enum", values: ["graceful", "forced", "crash", "unknown"] },
    },
  },
  "server.boot.heartbeat": {
    privacyLevel: "essential",
    properties: { appVersion, buildChannel },
  },
  "project.added": {
    privacyLevel: "product",
    properties: { method: { kind: "enum", values: ["picker", "drag-drop", "recent", "unknown"] } },
  },
  "project.add.failed": {
    privacyLevel: "essential",
    properties: {
      stage: {
        kind: "enum",
        values: ["validation", "inspection", "registration", "navigation", "unknown"],
      },
    },
  },
  "project.opened": {
    privacyLevel: "product",
    properties: {
      projectState: { kind: "enum", values: ["existing", "new", "unknown"] },
      initializationState: {
        kind: "enum",
        values: ["initialized", "missing", "partial", "unavailable", "unknown"],
      },
    },
  },
  "project.initialization.completed": {
    privacyLevel: "product",
    properties: {
      outcome: { kind: "enum", values: ["created", "already-ready", "repaired", "unknown"] },
      filesCreatedBucket: countBucket,
    },
  },
  "project.initialization.failed": {
    privacyLevel: "essential",
    properties: {
      failureClass: {
        kind: "enum",
        values: ["filesystem", "permission", "validation", "unavailable", "unknown"],
      },
    },
  },
  "provider.session.started": {
    privacyLevel: "product",
    properties: {
      provider,
      runtimeMode,
      hasResumeCursor: { kind: "boolean" },
      hasCwd: { kind: "boolean" },
      hasModel: { kind: "boolean" },
    },
  },
  "provider.session.recovered": {
    privacyLevel: "product",
    properties: {
      provider,
      strategy: { kind: "enum", values: ["adopt-existing", "resume-thread"] },
      hasResumeCursor: { kind: "boolean" },
    },
  },
  "provider.session.stopped": {
    privacyLevel: "product",
    properties: {
      provider,
      stopClass: {
        kind: "enum",
        values: ["requested", "replaced", "shutdown", "stale", "unknown"],
        optional: true,
      },
    },
  },
  "provider.sessions.stopped_all": {
    privacyLevel: "essential",
    properties: {
      sessionCountBucket: countBucket,
      shutdownClass: { kind: "enum", values: ["graceful", "forced", "crash", "unknown"] },
    },
  },
  "provider.runtime_mode.changed": {
    privacyLevel: "product",
    properties: { provider, from: runtimeMode, to: runtimeMode },
  },
  "provider.turn.sent": {
    privacyLevel: "product",
    properties: {
      provider,
      modelFamily: {
        kind: "enum",
        values: ["openai", "anthropic", "google", "xai", "open-source", "other", "unknown"],
      },
      modelKey,
      interactionMode: { kind: "enum", values: ["default", "plan", "other", "unknown"] },
      runtimeMode,
      attachmentCountBucket: countBucket,
      hasInput: { kind: "boolean" },
    },
  },
  "provider.turn.completed": {
    privacyLevel: "product",
    properties: {
      provider,
      modelKey,
      durationBucket,
      usedTools: { kind: "boolean" },
      hasAttachment: { kind: "boolean" },
    },
  },
  "provider.turn.failed": {
    privacyLevel: "essential",
    properties: {
      provider,
      modelKey,
      failureClass: {
        kind: "enum",
        values: [
          "provider_error",
          "transport_error",
          "permission_error",
          "validation_error",
          "interrupted",
          "cancelled",
          "unknown",
        ],
      },
      durationBucket,
    },
  },
  "provider.turn.stopped": {
    privacyLevel: "product",
    properties: {
      provider,
      modelKey,
      durationBucket,
      stopClass: { kind: "enum", values: ["aborted", "cancelled", "interrupted", "unknown"] },
    },
  },
  "provider.turn.interrupted": {
    privacyLevel: "product",
    properties: { provider, initiator: { kind: "enum", values: ["user", "system", "unknown"] } },
  },
  "provider.request.responded": {
    privacyLevel: "product",
    properties: {
      provider,
      requestKind: { kind: "enum", values: ["approval", "user-input", "other", "unknown"] },
      decision: {
        kind: "enum",
        values: ["approved", "approved-session", "denied", "answered", "cancelled", "unknown"],
      },
    },
  },
  "provider.conversation.rolled_back": {
    privacyLevel: "product",
    properties: { provider, turnCountBucket: countBucket },
  },
  "thread.created": {
    privacyLevel: "product",
    properties: { creationSource: { kind: "enum", values: ["new", "fork", "import", "unknown"] } },
  },
  "thread.fork.completed": {
    privacyLevel: "product",
    properties: {
      workspaceMode: { kind: "enum", values: ["local", "new-worktree", "unknown"] },
      boundaryClass: { kind: "enum", values: ["conversation", "checkpoint", "unknown"] },
      refork: { kind: "boolean" },
    },
  },
  "thread.fork.failed": {
    privacyLevel: "essential",
    properties: {
      workspaceMode: { kind: "enum", values: ["local", "new-worktree", "unknown"] },
      failureClass: {
        kind: "enum",
        values: [
          "checkpoint-unavailable",
          "git-unavailable",
          "provisioning",
          "validation",
          "unknown",
        ],
      },
    },
  },
  "thread.revert.completed": {
    privacyLevel: "product",
    properties: { boundaryClass: { kind: "enum", values: ["checkpoint"] } },
  },
  "thread.revert.failed": {
    privacyLevel: "essential",
    properties: {
      failureClass: {
        kind: "enum",
        values: ["checkpoint-unavailable", "provider", "validation", "unknown"],
      },
    },
  },
  "voice.transcription.started": {
    privacyLevel: "product",
    properties: {
      engineClass: { kind: "enum", values: ["local-whisper", "system", "other"] },
      languageMode: { kind: "enum", values: ["automatic", "explicit", "unknown"] },
    },
  },
  "voice.transcription.completed": {
    privacyLevel: "product",
    properties: {
      engineClass: { kind: "enum", values: ["local-whisper", "system", "other"] },
      durationBucket,
      audioDurationBucket: durationBucket,
    },
  },
  "voice.transcription.failed": {
    privacyLevel: "essential",
    properties: {
      engineClass: { kind: "enum", values: ["local-whisper", "system", "other"] },
      failureClass: {
        kind: "enum",
        values: ["permission", "model-unavailable", "audio", "engine", "cancelled", "unknown"],
      },
    },
  },
  "voice.transcription.cancelled": {
    privacyLevel: "product",
    properties: { stage: { kind: "enum", values: ["recording", "transcribing", "unknown"] } },
  },
  "surface.opened": {
    privacyLevel: "product",
    properties: {
      surface: {
        kind: "enum",
        values: [
          "files",
          "preview",
          "browser",
          "terminal",
          "usage",
          "settings",
          "whats-new",
          "unknown",
        ],
      },
    },
  },
  "panel.viewed": {
    privacyLevel: "product",
    properties: {
      category: {
        kind: "enum",
        values: [
          "browser",
          "terminal",
          "files",
          "file-preview",
          "diff",
          "pull-request",
          "agents",
          "sources",
          "compute",
          "source-pdf",
          "generated-pdf",
          "artifact",
          "other",
        ],
      },
    },
  },
  "settings.viewed": {
    privacyLevel: "product",
    properties: {
      section: {
        kind: "enum",
        values: [
          "general",
          "appearance",
          "projects",
          "keybindings",
          "providers",
          "custom-models",
          "voice",
          "skills",
          "integrations",
          "scientific-computing",
          "source-control",
          "connections",
          "archived",
          "other",
        ],
      },
    },
  },
  "usage.viewed": {
    privacyLevel: "product",
    properties: {
      metric: { kind: "enum", values: ["tokens", "cost", "limits", "other"] },
      window: { kind: "enum", values: ["1", "7", "30", "90", "other"] },
      breakdown: { kind: "enum", values: ["model", "time", "other"] },
    },
  },
  "usage.refresh.requested": { privacyLevel: "product", properties: {} },
  "feature.viewed": {
    privacyLevel: "product",
    properties: {
      feature: { kind: "enum", values: ["search", "project-picker", "new-thread", "other"] },
    },
  },
  "usage.availability": {
    privacyLevel: "product",
    properties: {
      state: { kind: "enum", values: ["available", "partial", "unavailable", "other"] },
    },
  },
  "provider.turn.usage": {
    privacyLevel: "product",
    properties: {
      provider,
      modelKey,
      terminalStatus: { kind: "enum", values: ["completed", "failed", "stopped", "other"] },
      usageStatus: { kind: "enum", values: ["complete", "partial", "unavailable"] },
      usageScope: { kind: "enum", values: ["main_agent"] },
      hasSubagents: { kind: "boolean", optional: true },
      inputTokens: { kind: "integer", max: 1_000_000_000, optional: true },
      outputTokens: { kind: "integer", max: 1_000_000_000, optional: true },
      cachedInputTokens: { kind: "integer", max: 1_000_000_000, optional: true },
      cacheCreationTokens: { kind: "integer", max: 1_000_000_000, optional: true },
      reasoningTokens: { kind: "integer", max: 1_000_000_000, optional: true },
    },
  },
  "setting.changed": {
    privacyLevel: "product",
    properties: {
      setting: { kind: "enum", values: ["direction", "theme", "notifications", "unknown"] },
      value: {
        kind: "enum",
        values: [
          "automatic",
          "ltr",
          "rtl",
          "system",
          "light",
          "dark",
          "enabled",
          "disabled",
          "unknown",
        ],
      },
    },
  },
  "scient.operation.started": {
    privacyLevel: "product",
    properties: operationProperties,
  },
  "scient.operation.completed": {
    privacyLevel: "product",
    properties: operationProperties,
  },
  "scient.operation.failed": {
    privacyLevel: "essential",
    properties: operationProperties,
  },
  "scient.operation.cancelled": { privacyLevel: "product", properties: operationProperties },
  "scient.operation.skipped": { privacyLevel: "product", properties: operationProperties },
} as const satisfies Readonly<Record<string, EventDefinition>>;

export type RegisteredEventName = keyof typeof EVENT_DEFINITIONS;

const PRIVACY_RANK: Readonly<Record<PrivacyLevel, number>> = {
  essential: 0,
  product: 1,
  diagnostic: 2,
  contribution: 3,
};

function propertyViolation(key: string, value: unknown, rule: PropertyRule): string | null {
  if (rule.kind === "integer") {
    return typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= rule.max
      ? null
      : `Invalid event property '${key}'`;
  }
  if (rule.kind === "boolean") {
    return typeof value === "boolean" ? null : `Invalid event property '${key}'`;
  }
  if (rule.kind === "enum") {
    return typeof value === "string" && rule.values.includes(value)
      ? null
      : `Invalid event property '${key}'`;
  }
  return typeof value === "string" && rule.pattern.test(value)
    ? null
    : `Invalid event property '${key}'`;
}

export function eventContractViolation(input: {
  readonly name: string;
  readonly privacyLevel: PrivacyLevel;
  readonly consentLevel: PrivacyLevel;
  readonly properties: Readonly<Record<string, unknown>>;
}): string | null {
  if (!Object.hasOwn(EVENT_DEFINITIONS, input.name)) {
    return `Unregistered event '${input.name}'`;
  }
  const definition = EVENT_DEFINITIONS[input.name as RegisteredEventName];
  if (input.privacyLevel !== definition.privacyLevel) {
    return `Event '${input.name}' requires privacy level '${definition.privacyLevel}'`;
  }
  if (PRIVACY_RANK[input.consentLevel] < PRIVACY_RANK[definition.privacyLevel]) {
    return `Consent level '${input.consentLevel}' does not allow event '${input.name}'`;
  }

  const rules: Readonly<Record<string, PropertyRule>> = {
    appVersion,
    buildChannel,
    contractRevision: { kind: "enum", values: ["1", "2", "3"], optional: true },
    ...definition.properties,
  };
  for (const key of Object.keys(input.properties)) {
    if (!Object.hasOwn(rules, key)) {
      return `Unregistered property '${key}' for event '${input.name}'`;
    }
  }
  for (const [key, rule] of Object.entries(rules)) {
    const value = input.properties[key];
    if (value === undefined) {
      if (!rule.optional) return `Missing event property '${key}'`;
      continue;
    }
    const violation = propertyViolation(key, value, rule);
    if (violation) return violation;
  }
  if (input.name === "provider.turn.usage") {
    const p = input.properties;
    const counts = [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "cacheCreationTokens",
      "reasoningTokens",
    ];
    if (
      p.usageStatus === "complete" &&
      (p.inputTokens === undefined || p.outputTokens === undefined)
    )
      return "Incomplete token totals";
    if (p.usageStatus === "unavailable" && counts.some((key) => p[key] !== undefined))
      return "Unavailable usage includes counts";
    for (const [subset, total] of [
      ["cachedInputTokens", "inputTokens"],
      ["cacheCreationTokens", "inputTokens"],
      ["reasoningTokens", "outputTokens"],
    ] as const) {
      const subsetValue = p[subset];
      const totalValue = p[total];
      if (
        typeof subsetValue === "number" &&
        typeof totalValue === "number" &&
        subsetValue > totalValue
      )
        return "Token subset exceeds total";
    }
  }
  return null;
}
