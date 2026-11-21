import type { Config } from "wagmi";

/**
 * Resolves once wagmi has finished restoring or establishing the wallet connection.
 *
 * After a reload the page already shows the account remembered in the cookie, while the
 * wallet behind it is still being reattached. An action taken in that moment has to wait.
 */
export function connectionSettled(config: Config): Promise<void> {
  const settled = () => config.state.status !== "reconnecting" && config.state.status !== "connecting";
  if (settled()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const unsubscribe = config.subscribe(state => state.status, () => {
      if (settled()) {
        unsubscribe();
        resolve();
      }
    });
  });
}
