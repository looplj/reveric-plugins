import type { PluginSetup } from "reveric-plugin-sdk";
import { createXiaoyunqueProvider } from "./provider";

export const provider = createXiaoyunqueProvider();
export function apply(setup: PluginSetup): void {
  setup.provider.register(provider);
}
