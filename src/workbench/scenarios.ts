import {
  createDefaultConfiguration,
  createManagedGroup
} from "../domain/defaults";
import type { Configuration, Rule, UUID } from "../domain/types";
import type { ManagerViewFixture } from "../ui/manager/types";
import type {
  FixtureFailurePolicy,
  ScenarioDefinition,
  WorkbenchUrlState
} from "./types";

const SEED_TIME = 1_800_000_000_000;
const PAUSED_FIXTURE_UNTIL = 4_102_444_800_000;

export const FIXTURE_IDS = {
  fallbackGroup: "00000000-0000-4000-8000-000000000001" as UUID,
  primaryGroup: "00000000-0000-4000-8000-000000000002" as UUID,
  secondaryGroup: "00000000-0000-4000-8000-000000000003" as UUID,
  editRule: "00000000-0000-4000-8000-000000000101" as UUID,
  pausedRule: "00000000-0000-4000-8000-000000000102" as UUID,
  disabledRule: "00000000-0000-4000-8000-000000000103" as UUID,
  ungroupedRule: "00000000-0000-4000-8000-000000000104" as UUID
} as const;

const DENSE_GROUP_IDS = [
  "00000000-0000-4000-8000-000000000011",
  "00000000-0000-4000-8000-000000000012",
  "00000000-0000-4000-8000-000000000013",
  "00000000-0000-4000-8000-000000000014",
  "00000000-0000-4000-8000-000000000015",
  "00000000-0000-4000-8000-000000000016",
  "00000000-0000-4000-8000-000000000017",
  "00000000-0000-4000-8000-000000000018"
] as const;

function emptyViewFixture(): ManagerViewFixture {
  return { persistentTabsByGroup: {} };
}

function cloneFailure(policy: FixtureFailurePolicy): FixtureFailurePolicy {
  return policy.mode === "none" ? { mode: "none" } : { ...policy };
}

function defaultConfiguration(): Configuration {
  let configuration = createDefaultConfiguration(
    () => FIXTURE_IDS.fallbackGroup,
    () => SEED_TIME
  );
  configuration = createManagedGroup(
    configuration,
    {
      name: "Work",
      color: "blue",
      emoji: "💼",
      isPersistent: true,
      defaultCollapsed: false
    },
    () => FIXTURE_IDS.primaryGroup,
    () => SEED_TIME
  );
  return configuration;
}

function withPrimaryGroupFirst(configuration: Configuration): Configuration {
  const primary = configuration.groups.find(
    (group) => group.id === FIXTURE_IDS.primaryGroup
  );
  if (!primary) return configuration;
  return {
    ...configuration,
    groups: [
      primary,
      ...configuration.groups.filter(
        (group) => group.id !== FIXTURE_IDS.primaryGroup
      )
    ]
  };
}

function rule(
  id: UUID,
  targetGroupId: UUID,
  input: {
    priority: number;
    enabled?: boolean;
    pausedUntil?: number | "restart";
    actions?: Rule["actions"];
    host: string;
  }
): Rule {
  return {
    schemaVersion: 1,
    id,
    targetGroupId,
    priority: input.priority,
    positive: { kind: "host", operator: "suffix", value: input.host },
    negative: [],
    actions: input.actions ?? [{ kind: "group" }],
    enabled: input.enabled ?? true,
    ...(input.pausedUntil === undefined
      ? {}
      : { pausedUntil: input.pausedUntil }),
    createdAt: SEED_TIME + input.priority,
    updatedAt: SEED_TIME + input.priority
  };
}

function withEditRule(configuration: Configuration): Configuration {
  return {
    ...configuration,
    rules: [
      rule(FIXTURE_IDS.editRule, FIXTURE_IDS.primaryGroup, {
        priority: 40,
        host: "docs.example.test"
      })
    ]
  };
}

export const SCENARIO_IDS = [
  "wb:default",
  "wb:empty-groups",
  "wb:dense-groups",
  "wb:enabled-group",
  "wb:disabled-group",
  "wb:empty-persistent-tabs",
  "wb:populated-persistent-tabs",
  "wb:mixed-rules-overview",
  "wb:new-rule",
  "wb:edit-rule",
  "wb:confirmation-overlay",
  "wb:loading",
  "wb:slow",
  "wb:validation-error",
  "wb:offline",
  "wb:sync-incomplete",
  "wb:local-budget"
] as const;

type ScenarioId = (typeof SCENARIO_IDS)[number];

const PRIMARY_GROUP_FIRST_SCENARIOS: ReadonlySet<ScenarioId> = new Set([
  "wb:enabled-group",
  "wb:disabled-group",
  "wb:empty-persistent-tabs",
  "wb:populated-persistent-tabs"
]);

function diagnosticsFixture(
  warnings: import("../settings/diagnosticsState").DiagnosticsWarningCode[]
): ManagerViewFixture {
  return {
    persistentTabsByGroup: {},
    diagnostics: {
      storage: {
        syncBytes: warnings.includes("SYNC_QUOTA") ? 102401 : 1200,
        syncQuotaBytes: 102400,
        syncLargestItemBytes: 400,
        syncQuotaBytesPerItem: 8192,
        syncItemCount: 2,
        syncMaxItems: 512,
        localBytes: warnings.includes("LOCAL_BUDGET") ? 9437185 : 5000,
        localSoftBudgetBytes: 9437184,
        localQuotaBytes: 10485760,
        sessionBytes: 200,
        sessionQuotaBytes: 10485760
      },
      warnings
    }
  };
}

function createSeedFor(id: ScenarioId): {
  configuration: Configuration;
  viewFixture: ManagerViewFixture;
} {
  if (id === "wb:sync-incomplete") {
    return {
      configuration: defaultConfiguration(),
      viewFixture: diagnosticsFixture(["SYNC_INCOMPLETE"])
    };
  }

  if (id === "wb:local-budget") {
    return {
      configuration: defaultConfiguration(),
      viewFixture: diagnosticsFixture(["LOCAL_BUDGET"])
    };
  }

  if (id === "wb:empty-groups") {
    return {
      configuration: createDefaultConfiguration(
        () => FIXTURE_IDS.fallbackGroup,
        () => SEED_TIME
      ),
      viewFixture: emptyViewFixture()
    };
  }

  let configuration = defaultConfiguration();
  const viewFixture = emptyViewFixture();

  if (id === "wb:dense-groups") {
    const names = [
      "Research",
      "Projects",
      "Inbox",
      "Reading",
      "Media",
      "Admin",
      "Shopping",
      "Later"
    ];
    const colors = [
      "cyan",
      "green",
      "yellow",
      "purple",
      "red",
      "orange",
      "pink",
      "grey"
    ] as const;
    for (let index = 0; index < DENSE_GROUP_IDS.length; index += 1) {
      configuration = createManagedGroup(
        configuration,
        { name: names[index]!, color: colors[index]! },
        () => DENSE_GROUP_IDS[index]!,
        () => SEED_TIME + index + 1
      );
    }
  }

  if (id === "wb:disabled-group") {
    configuration = {
      ...configuration,
      groups: configuration.groups.map((group) =>
        group.id === FIXTURE_IDS.primaryGroup
          ? { ...group, enabled: false, updatedAt: SEED_TIME + 1 }
          : group
      ),
      updatedAt: SEED_TIME + 1
    };
  }

  if (id === "wb:default" || id === "wb:offline") {
    viewFixture.activity = [
      {
        schemaVersion: 1,
        id: "00000000-0000-4000-8000-000000000201" as import("../domain/types").UUID,
        action: "Closed duplicate tab",
        result: "success",
        affectedManagedGroupIds: [FIXTURE_IDS.primaryGroup],
        affectedUrls: ["https://docs.example.test/guide"],
        undoId:
          "00000000-0000-4000-8000-000000000202" as import("../domain/types").UUID,
        createdAt: SEED_TIME
      }
    ];
    viewFixture.availableUndo = {
      schemaVersion: 1,
      id: "00000000-0000-4000-8000-000000000202" as import("../domain/types").UUID,
      actionId:
        "00000000-0000-4000-8000-000000000203" as import("../domain/types").ActionId,
      browserSessionId:
        "00000000-0000-4000-8000-000000000204" as import("../domain/types").BrowserSessionId,
      payloads: [],
      expiresAt: SEED_TIME + 30_000,
      createdAt: SEED_TIME
    };
  }

  if (id === "wb:empty-persistent-tabs") {
    viewFixture.persistentTabsByGroup = {
      [FIXTURE_IDS.primaryGroup]: { state: "empty", tabs: [] }
    };
  }

  if (id === "wb:populated-persistent-tabs") {
    configuration = {
      ...configuration,
      persistentTabs: [
        {
          schemaVersion: 1,
          id: "00000000-0000-4000-8000-000000000301" as import("../domain/types").UUID,
          managedGroupId: FIXTURE_IDS.primaryGroup,
          canonicalUrl: "https://docs.example.test/",
          acceptedPatterns: ["https://docs.example.test/"],
          order: 0,
          createdAt: SEED_TIME,
          updatedAt: SEED_TIME
        },
        {
          schemaVersion: 1,
          id: "00000000-0000-4000-8000-000000000302" as import("../domain/types").UUID,
          managedGroupId: FIXTURE_IDS.primaryGroup,
          canonicalUrl: "https://mail.example.test/inbox",
          acceptedPatterns: ["https://mail.example.test/inbox"],
          order: 1,
          createdAt: SEED_TIME,
          updatedAt: SEED_TIME
        }
      ]
    };
    viewFixture.persistentTabsByGroup = {
      [FIXTURE_IDS.primaryGroup]: {
        state: "populated",
        tabs: [
          "Docs — https://docs.example.test/",
          "Inbox — https://mail.example.test/inbox"
        ],
        persistentTabRecords: configuration.persistentTabs
      }
    };
  }

  if (id === "wb:mixed-rules-overview") {
    configuration = createManagedGroup(
      configuration,
      { name: "Personal", color: "green" },
      () => FIXTURE_IDS.secondaryGroup,
      () => SEED_TIME + 1
    );
    configuration = {
      ...configuration,
      rules: [
        rule(FIXTURE_IDS.editRule, FIXTURE_IDS.primaryGroup, {
          priority: 40,
          host: "docs.example.test"
        }),
        rule(FIXTURE_IDS.pausedRule, FIXTURE_IDS.primaryGroup, {
          priority: 30,
          host: "calendar.example.test",
          pausedUntil: PAUSED_FIXTURE_UNTIL
        }),
        rule(FIXTURE_IDS.disabledRule, FIXTURE_IDS.secondaryGroup, {
          priority: 20,
          host: "social.example.test",
          enabled: false
        }),
        rule(FIXTURE_IDS.ungroupedRule, FIXTURE_IDS.primaryGroup, {
          priority: 10,
          host: "plain.example.test",
          actions: [{ kind: "ungroup" }]
        })
      ]
    };
  }

  if (id === "wb:edit-rule" || id === "wb:confirmation-overlay") {
    configuration = withEditRule(configuration);
  }

  if (PRIMARY_GROUP_FIRST_SCENARIOS.has(id)) {
    configuration = withPrimaryGroupFirst(configuration);
  }

  return { configuration, viewFixture };
}

function definition(
  id: ScenarioId,
  route: ScenarioDefinition["route"],
  deepLink: ScenarioDefinition["deepLink"],
  expected: ScenarioDefinition["expected"],
  transport: {
    latencyMs?: number;
    failure?: FixtureFailurePolicy;
  } = {}
): ScenarioDefinition {
  return {
    id,
    route,
    deepLink,
    latencyMs: transport.latencyMs ?? 0,
    failure: cloneFailure(transport.failure ?? { mode: "none" }),
    createSeed: () => createSeedFor(id),
    expected
  };
}

export const SCENARIO_DEFINITIONS: readonly ScenarioDefinition[] = [
  definition("wb:default", "groups", "none", {
    heading: "Groups",
    status: "ready",
    description: "Default managed-group state"
  }),
  definition("wb:empty-groups", "groups", "none", {
    heading: "Groups",
    status: "ready",
    description: "No non-fallback groups",
    snippets: ["Other"]
  }),
  definition("wb:dense-groups", "groups", "none", {
    heading: "Groups",
    status: "ready",
    description: "Dense managed-group navigation"
  }),
  definition("wb:enabled-group", "groups", "none", {
    heading: "Groups",
    status: "ready",
    description: "Enabled selected group"
  }),
  definition("wb:disabled-group", "groups", "none", {
    heading: "Groups",
    status: "ready",
    description: "Disabled selected group"
  }),
  definition("wb:empty-persistent-tabs", "groups", "none", {
    heading: "Groups",
    status: "ready",
    description: "Empty persistent-tab display"
  }),
  definition("wb:populated-persistent-tabs", "groups", "none", {
    heading: "Groups",
    status: "ready",
    description: "Populated persistent-tab display",
    snippets: [
      "Docs — https://docs.example.test/",
      "Inbox — https://mail.example.test/inbox"
    ]
  }),
  definition("wb:mixed-rules-overview", "rules", "none", {
    heading: "Rules",
    status: "ready",
    description: "Mixed rule statuses",
    snippets: ["Active", "Paused", "Off"]
  }),
  definition("wb:new-rule", "rules", "new-rule", {
    heading: "New rule",
    status: "ready",
    description: "New rule editor"
  }),
  definition(
    "wb:edit-rule",
    "rules",
    { kind: "edit-rule", ruleId: FIXTURE_IDS.editRule },
    {
      heading: "Edit rule",
      status: "ready",
      description: "Existing rule editor"
    }
  ),
  definition(
    "wb:confirmation-overlay",
    "rules",
    { kind: "confirm-delete", ruleId: FIXTURE_IDS.editRule },
    {
      heading: "Rules",
      status: "ready",
      description: "Delete confirmation overlay",
      dialogTitle: "Delete rule?"
    }
  ),
  definition("wb:loading", "groups", "none", {
    heading: "Groups",
    status: "loading",
    description: "Initial query waits for explicit release"
  }),
  definition(
    "wb:slow",
    "groups",
    "none",
    {
      heading: "Groups",
      status: "ready",
      description: "Ready state after deterministic latency"
    },
    { latencyMs: 250 }
  ),
  definition(
    "wb:validation-error",
    "rules",
    "new-rule",
    {
      heading: "New rule",
      status: "error",
      description: "Injected validation failure"
    },
    { failure: { mode: "validation", scope: "persistent" } }
  ),
  definition(
    "wb:offline",
    "groups",
    "none",
    {
      heading: "Groups",
      status: "error",
      description: "Injected offline failure"
    },
    { failure: { mode: "offline", scope: "persistent" } }
  ),
  definition("wb:sync-incomplete", "settings", "diagnostics", {
    heading: "Diagnostics",
    status: "ready",
    description: "Pending sync revision diagnostics"
  }),
  definition("wb:local-budget", "settings", "diagnostics", {
    heading: "Diagnostics",
    status: "ready",
    description: "Local storage soft-budget warning"
  })
];

const scenarioById = new Map(
  SCENARIO_DEFINITIONS.map((candidate) => [candidate.id, candidate])
);

export function getScenarioDefinition(id: string): ScenarioDefinition {
  const scenario = scenarioById.get(id);
  if (!scenario) throw new Error(`Unknown workbench scenario: ${id}`);
  return scenario;
}

export function getScenarioDefaultUrlState(id: string): WorkbenchUrlState {
  const scenario = getScenarioDefinition(id);
  return {
    workbench: true,
    mode: "fixture",
    route: scenario.route,
    scenarioId: scenario.id,
    deepLink: scenario.deepLink,
    latencyMs: scenario.latencyMs,
    failure: cloneFailure(scenario.failure)
  };
}
