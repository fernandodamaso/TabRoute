import { reconstructAssociations } from "../chrome/reconstructAssociations";
import type { ChromeMutationPort } from "../chrome/types";
import { isRoutableUrl } from "../chrome/types";
import type { Configuration, ChromeInventory, ChromeTabSnapshot } from "../domain/types";
import { executeActionPlan } from "../actions/executeActionPlan";
import { planFallbackRoute } from "../actions/planActions";
import type { SessionRepository } from "../state/sessionRepository";

export function createTabRouteController(input: {
  configuration: Configuration;
  chrome: ChromeMutationPort;
  session: SessionRepository;
}) {
  async function currentAssociations(inventory: ChromeInventory) {
    const stored = await input.session.loadAssociations();
    const rebuilt = reconstructAssociations(inventory, input.configuration);
    const associations = rebuilt.length > 0 ? rebuilt : stored;
    if (rebuilt.length > 0) await input.session.saveAssociations(associations);
    return associations;
  }

  return {
    async handleTabUpdated(tab: ChromeTabSnapshot) {
      if (tab.incognito || !isRoutableUrl(tab.url)) return { kind: "held", reason: "not-routable" } as const;
      const inventory = await input.chrome.readInventory();
      const associations = await currentAssociations(inventory);
      const planned = planFallbackRoute({ inventory, tab, configuration: input.configuration, associations });
      if (planned.kind === "held" || planned.kind === "noop") return planned;
      const result = await executeActionPlan(planned, input.chrome);
      if (result.kind === "executed") {
        await input.session.saveAssociations(reconstructAssociations(result.inventory, input.configuration));
      }
      return result;
    }
  };
}
