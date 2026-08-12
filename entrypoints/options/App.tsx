import { ManagerApp } from "../../src/ui/manager/ManagerApp";
import { WorkbenchOptionsApp } from "../../src/workbench/WorkbenchOptionsApp";

export function App() {
  if (typeof __TABROUTE_WORKBENCH__ !== "undefined" && __TABROUTE_WORKBENCH__)
    return <WorkbenchOptionsApp />;
  return <ManagerApp surface="options" />;
}
