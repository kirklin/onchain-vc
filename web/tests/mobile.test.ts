import { describe, expect, it } from "vitest";
import { metamaskDappLink } from "~/chain/mobile";

describe("metamaskDappLink", () => {
  it("names the page without its scheme, as MetaMask's deeplink expects", () => {
    expect(metamaskDappLink(new URL("https://app.example/"))).toBe("https://link.metamask.io/dapp/app.example/");
    expect(metamaskDappLink(new URL("https://app.example/token"))).toBe("https://link.metamask.io/dapp/app.example/token");
  });

  it("keeps the port and the query, so a payment link opens as the same request", () => {
    expect(metamaskDappLink(new URL("http://192.168.1.20:3000/pay?chain=1&to=0x70997970C51812dc3A010C7d01b50e0d17dc79C8&amount=5")))
      .toBe("https://link.metamask.io/dapp/192.168.1.20:3000/pay?chain=1&to=0x70997970C51812dc3A010C7d01b50e0d17dc79C8&amount=5");
  });
});
