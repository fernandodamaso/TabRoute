import type { Configuration } from "../domain/types";

export type UiMessage =
  | { kind: "get-configuration" }
  | { kind: "save-configuration"; configuration: Configuration };
