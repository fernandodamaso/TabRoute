import { lazy, Suspense } from "react";
import { ManagerApp } from "../../src/ui/manager/ManagerApp";

const WorkbenchOptionsApp = lazy(() => import("../../src/workbench/WorkbenchOptionsApp").then((module) => ({ default: module.WorkbenchOptionsApp })));

export function App() {
  if (typeof __TABROUTE_WORKBENCH__ !== "undefined" && __TABROUTE_WORKBENCH__)
    return <Suspense fallback={<ManagerApp surface="options" />}><WorkbenchOptionsApp /></Suspense>;
  return <ManagerApp surface="options" />;
}
