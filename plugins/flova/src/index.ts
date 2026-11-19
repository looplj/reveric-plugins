import type { PluginSetup } from "reveric-plugin-sdk";
import { createFlovaProvider } from "./provider";

export const provider = createFlovaProvider();
export function apply(setup: PluginSetup): void {
  setup.provider.register(provider);
}
