import { reconstructAssociations } from "../chrome/reconstructAssociations";
import type { ChromeMutationPort } from "../chrome/types";
import { isRoutableUrl } from "../chrome/types";
import type {
  Configuration,
  ChromeInventory,
  ChromeTabSnapshot
} from "../domain/types";
import { executeActionPlan } from "../actions/executeActionPlan";
import { planRuleRoute } from "../actions/planActions";
import type { SessionRepository } from "../state/sessionRepository";

export function createTabRouteController(input: {
  configuration: Configuration;
  chrome: ChromeMutationPort;
  session: SessionRepository;
}) {
  async function currentAssociations(inventory: ChromeInventory) {
    const stored = await input.session.loadAssociations();
    const rebuilt = reconstructAssociations(inventory, configuration);
    const associations = rebuilt.length > 0 ? rebuilt : stored;
    if (rebuilt.length > 0) await input.session.saveAssociations(associations);
    return associations;
  }

  let configuration = input.configuration;

  async function reconcileTab(tab: ChromeTabSnapshot) {
    if (tab.incognito || !isRoutableUrl(tab.url))
      return { kind: "held", reason: "not-routable" } as const;
    const inventory = await input.chrome.readInventory();
    const freshTab =
      inventory.tabs.find((candidate) => candidate.id === tab.id) ?? tab;
    const associations = await currentAssociations(inventory);
    if (
      !configuration.automationEnabled ||
      configuration.globalPausedUntil === "restart" ||
      (typeof configuration.globalPausedUntil === "number" &&
        configuration.globalPausedUntil > Date.now())
    )
      return { kind: "held", reason: "paused" } as const;
    const planned = planRuleRoute({
      inventory,
      tab: freshTab,
      configuration,
      associations
    });
    if (planned.kind === "held" || planned.kind === "noop") return planned;
    const result = await executeActionPlan(planned, input.chrome);
    if (result.kind === "executed") {
      await input.session.saveAssociations(
        reconstructAssociations(result.inventory, configuration)
      );
    }
    return result;
  }

  return {
    async handleTabUpdated(tab: ChromeTabSnapshot) {
      return reconcileTab(tab);
    },
    async replaceConfiguration(nextConfiguration: Configuration) {
      configuration = nextConfiguration;
      const inventory = await input.chrome.readInventory();
      for (const tab of inventory.tabs) await reconcileTab(tab);
    },
    getConfiguration() {
      return configuration;
    }
  };
}
