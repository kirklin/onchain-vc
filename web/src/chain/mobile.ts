const MOBILE = /Android|iPhone|iPad|iPod/i;

/**
 * The link that opens a page of this app inside MetaMask's own browser on a phone, where
 * the wallet is available to the page. A phone's ordinary browser has no wallet in it, so
 * this is how someone without one gets to connect. MetaMask documents the form as
 * `https://link.metamask.io/dapp/{dappUrl}`, the page's address without its scheme.
 */
export function metamaskDappLink(page: URL): string {
  return `https://link.metamask.io/dapp/${page.host}${page.pathname}${page.search}`;
}

/** Whether the page is open in a phone or tablet browser that carries no wallet. */
export function isWalletlessMobile(): boolean {
  return typeof window !== "undefined" && MOBILE.test(window.navigator.userAgent) && !("ethereum" in window);
}
