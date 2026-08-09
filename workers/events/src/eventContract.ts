export const PRIVACY_LEVELS = ["essential", "product", "diagnostic", "contribution"] as const;

export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

type PropertyRule =
  | { readonly kind: "boolean"; readonly optional?: boolean }
  | { readonly kind: "enum"; readonly values: ReadonlyArray<string>; readonly optional?: boolean }
  | { readonly kind: "pattern"; readonly pattern: RegExp; readonly optional?: boolean };

interface EventDefinition {
  readonly privacyLevel: Exclude<PrivacyLevel, "contribution">;
  readonly properties: Readonly<Record<string, PropertyRule>>;
}

const provider = {
  kind: "enum",
  values: ["codex", "claudeAgent", "cursor", "grok", "opencode", "other"],
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
  pattern: /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/,
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
    "openai/gpt-5",
    "other",
    "unknown",
  ],
} as const satisfies PropertyRule;

export const EVENT_DEFINITIONS = {
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
      workspaceMode: { kind: "enum", values: ["local", "new-worktree"] },
      boundaryClass: { kind: "enum", values: ["conversation", "checkpoint"] },
      refork: { kind: "boolean" },
    },
  },
  "thread.fork.failed": {
    privacyLevel: "essential",
    properties: {
      workspaceMode: { kind: "enum", values: ["local", "new-worktree"] },
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
        values: ["files", "preview", "browser", "terminal", "usage", "settings", "whats-new"],
      },
    },
  },
  "setting.changed": {
    privacyLevel: "product",
    properties: {
      setting: { kind: "enum", values: ["direction", "theme", "notifications"] },
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
    properties: {
      operationKind: { kind: "enum", values: ["other"] },
      trigger: { kind: "enum", values: ["user", "agent", "automation", "other"] },
    },
  },
  "scient.operation.completed": {
    privacyLevel: "product",
    properties: {
      operationKind: { kind: "enum", values: ["other"] },
      durationBucket,
      reviewRequired: { kind: "boolean" },
    },
  },
  "scient.operation.failed": {
    privacyLevel: "essential",
    properties: {
      operationKind: { kind: "enum", values: ["other"] },
      failureClass: {
        kind: "enum",
        values: [
          "configuration",
          "connection",
          "permission",
          "provider",
          "timeout",
          "filesystem",
          "checkpoint",
          "validation",
          "unavailable",
          "internal",
          "unknown",
        ],
      },
    },
  },
} as const satisfies Readonly<Record<string, EventDefinition>>;

export type RegisteredEventName = keyof typeof EVENT_DEFINITIONS;

const PRIVACY_RANK: Readonly<Record<PrivacyLevel, number>> = {
  essential: 0,
  product: 1,
  diagnostic: 2,
  contribution: 3,
};

function propertyViolation(key: string, value: unknown, rule: PropertyRule): string | null {
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
  return null;
}
