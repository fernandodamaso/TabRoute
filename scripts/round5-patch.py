from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(
            f"{path}: expected one match for {old[:70]!r}, found {count}"
        )
    file.write_text(text.replace(old, new, 1))


def replace_between(
    path: str, start_marker: str, end_marker: str, replacement: str
) -> None:
    file = Path(path)
    text = file.read_text()
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"{path}: start marker not found: {start_marker!r}")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"{path}: end marker not found: {end_marker!r}")
    file.write_text(text[:start] + replacement + text[end:])


runner = "src/controller/persistentRepairRunner.ts"
replace_once(
    runner,
    'import { persistentTabsForGroup } from "../persistence/requirements";',
    'import {\n  isGroupEligibleForRepair,\n  persistentTabsForGroup\n} from "../persistence/requirements";',
)
replace_once(
    runner,
    "  const inventory = await input.chrome.readInventory();\n"
    "  const context = await buildRestoreContext({",
    "  const inventory = await input.chrome.readInventory();\n"
    "  const hasNormalWindow = inventory.windows.some(\n"
    '    (window) => window.type === "normal" && !window.incognito\n'
    "  );\n"
    "  const hasEligibleRestoreTarget =\n"
    "    input.configuration.restorePersistentGroups &&\n"
    "    input.configuration.groups.some(\n"
    "      (group) =>\n"
    "        group.enabled &&\n"
    "        !group.isFallback &&\n"
    "        (group.isPersistent ||\n"
    "          persistentTabsForGroup(input.configuration, group.id).length > 0) &&\n"
    "        isGroupEligibleForRepair(\n"
    "          input.configuration,\n"
    "          group.id,\n"
    "          input.session.intentionallyClosedGroupIds\n"
    "        )\n"
    "    );\n"
    "  if (!hasNormalWindow && hasEligibleRestoreTarget) return false;\n\n"
    "  const context = await buildRestoreContext({",
)

requirements = "src/persistence/requirements.ts"
replace_between(
    requirements,
    "export function matchesPersistentDefinition(",
    "\n\nexport function isGroupEligibleForRepair(",
    '''export function matchesPersistentDefinition(
  tab: TabSnapshot | { url?: string; routing?: TabSnapshot["routing"] },
  definition: PersistentTab,
  duplicateSettings?: Configuration["duplicateSettings"]
): boolean {
  const url = tabUrl(tab);
  if (!url || !isRoutableUrl(url)) return false;
  if (
    matchesAcceptedUrl(
      url,
      definition.canonicalUrl,
      definition.acceptedPatterns
    )
  ) {
    return true;
  }
  if (!duplicateSettings) return false;
  const canonicalUrl = deriveCanonicalUrl(url, duplicateSettings);
  return matchesAcceptedUrl(
    canonicalUrl,
    definition.canonicalUrl,
    definition.acceptedPatterns
  );
}''',
)

startup = "src/persistence/startupRestore.ts"
replace_once(startup, 'import { matchesAcceptedUrl } from "./acceptedUrl";\n', "")
replace_between(
    startup,
    "function findMatchingNonSharedTab(",
    "\n\nfunction acceptableHomeMemberTabIds(",
    '''function findMatchingNonSharedTab(
  definition: PersistentTab,
  inventory: ChromeInventory,
  associations: readonly ChromeAssociation[],
  duplicateSettings: Configuration["duplicateSettings"]
): ChromeTabSnapshot | undefined {
  const matchingTabs = inventory.tabs.filter((tab) => {
    if (isTabInSharedGroup(tab, inventory)) return false;
    return matchesPersistentDefinition(
      tabSnapshotFromChrome(tab),
      definition,
      duplicateSettings
    );
  });
  return (
    matchingTabs.find((tab) =>
      isInTargetManagedGroup(tab, definition, inventory, associations)
    ) ?? matchingTabs[0]
  );
}''',
)
replace_once(
    startup,
    "    context.associations\n  );\n\n  if (matchingTab) {",
    "    context.associations,\n"
    "    context.configuration.duplicateSettings\n"
    "  );\n\n"
    "  if (matchingTab) {",
)
replace_between(
    startup,
    '    const url = matchingTab.url ?? "";',
    "\n    const inCorrectGroup =",
    '''    const canonicalMatch = matchesPersistentDefinition(
      tabSnapshotFromChrome(matchingTab),
      definition,
      context.configuration.duplicateSettings
    );''',
)
replace_once(
    startup,
    "    if (!matchesPersistentDefinition(snapshot, definition) && !inTargetGroup) {",
    "    if (\n"
    "      !matchesPersistentDefinition(\n"
    "        snapshot,\n"
    "        definition,\n"
    "        context.configuration.duplicateSettings\n"
    "      ) &&\n"
    "      !inTargetGroup\n"
    "    ) {",
)
replace_once(
    startup,
    "      return matchesPersistentDefinition(\n"
    "        tabSnapshotFromChrome(candidate),\n"
    "        definition\n"
    "      );",
    "      return matchesPersistentDefinition(\n"
    "        tabSnapshotFromChrome(candidate),\n"
    "        definition,\n"
    "        configuration.duplicateSettings\n"
    "      );",
)

file = Path(startup)
text = file.read_text()
plan_start = text.find("export function planPersistentRestore(")
association_start = text.find(
    "    const association = context.associations.find(\n", plan_start
)
if association_start < 0:
    raise SystemExit("startupRestore: ownership association block not found")
ownership_start = text.find(
    "    const ownership = context.ownership[group.id];", association_start
)
if ownership_start < 0:
    raise SystemExit("startupRestore: ownership marker not found")
file.write_text(text[:association_start] + text[ownership_start:])

replace_once(
    startup,
    "    if (association && ownership) {\n      const moveId = actionId();",
    "    if (ownership) {\n"
    "      const lastAssign = [...actions]\n"
    "        .reverse()\n"
    "        .find(\n"
    "          (action) =>\n"
    '            action.kind === "assignTabsToManagedGroup" &&\n'
    "            action.managedGroupId === group.id\n"
    "        );\n"
    "      const moveId = actionId();",
)
replace_once(
    startup,
    '        dependsOn: [],\n        kind: "moveManagedGroup",',
    '        dependsOn: lastAssign ? [lastAssign.id] : [],\n'
    '        kind: "moveManagedGroup",',
)
replace_once(
    startup,
    "        id: updateId,\n"
    "        dependsOn: [],\n"
    '        kind: "updateManagedGroup",\n'
    "        managedGroupId: group.id,\n"
    "        patch: { collapsed: ownership.collapsed }",
    "        id: updateId,\n"
    "        dependsOn: [moveId],\n"
    '        kind: "updateManagedGroup",\n'
    "        managedGroupId: group.id,\n"
    "        windowId: homeWindow,\n"
    "        patch: { collapsed: ownership.collapsed }",
)
replace_once(
    startup,
    "    if (!matchesPersistentDefinition(snapshot, definition)) continue;",
    "    if (\n"
    "      !matchesPersistentDefinition(\n"
    "        snapshot,\n"
    "        definition,\n"
    "        context.configuration.duplicateSettings\n"
    "      )\n"
    "    )\n"
    "      continue;",
)
