import type { Page } from "@playwright/test";
import type { Hex } from "viem";
import { Buffer } from "node:buffer";
import { expect, test } from "@playwright/test";
import * as jsqr from "jsqr";
import { accept, approve, bondOf, dealCount, dealOf, deployProject, investorKey, offer, pitchDirectly, publishProfiles, restoreBonds, vote } from "./chain.ts";

// jsqr is a CommonJS bundle. When it runs its `default` is the decoder, which its types put one level deeper.
const readQr = jsqr.default as unknown as typeof jsqr.default.default;

/** The address the site under test is served at. */
function site(): string {
  return test.info().project.use.baseURL!;
}

/** Everything the page reports as an error from here on: console errors and uncaught exceptions. */
function collectProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      problems.push(message.text());
    }
  });
  page.on("pageerror", error => problems.push(error.message));
  return problems;
}

/** Pitches a freshly deployed project from the page, as a visitor who arrived without a wallet. */
async function pitchFromPage(page: Page, name: string): Promise<bigint> {
  const project = await deployProject();
  await page.goto("/pitch");
  // The page makes the visitor a wallet of their own, with no prompt.
  await expect(page.getByRole("button", { name: /0x\w{4}…\w{4}$/ })).toBeVisible();

  await page.getByLabel("Project contract").fill(project);
  await expect(page.getByText(/^Contract found, \d+ bytes$/)).toBeVisible();
  await page.getByLabel("Project name").fill(name);
  await page.getByLabel("One-line summary").fill("Lets people at the venue pay for pizza on chain");
  await page.getByLabel("Details").fill("An ERC-20 anyone can claim once a day, accepted by two pizza places nearby.");
  await page.getByLabel("Ask").fill("500");
  await page.getByRole("button", { name: "Submit pitch" }).click();

  await page.waitForURL(/\/deals\/\d+$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  return BigInt(page.url().split("/").at(-1)!);
}

test("pitches without a wallet or gas, and shows the deal under review", async ({ page }) => {
  const problems = collectProblems(page);
  const dealId = await pitchFromPage(page, `Pizza ${test.info().project.name}`);

  const deal = page.getByTestId("deal");
  await expect(deal).toHaveAttribute("data-stage", "review");
  await expect(page.getByText("The committee is reviewing your pitch.")).toBeVisible();
  await expect(page.getByText("Lets people at the venue pay for pizza on chain")).toBeVisible();
  await expect(page.getByRole("img", { name: /Product Partner: Not voted/ }).first()).toBeVisible();
  expect((await dealOf(dealId)).ask).toBe(500n * 10n ** 18n);
  expect(problems).toEqual([]);
});

test("refuses an address without code, and a name the committee would refuse", async ({ page }) => {
  await page.goto("/pitch");
  await expect(page.getByRole("button", { name: /0x\w{4}…\w{4}$/ })).toBeVisible();

  await page.getByLabel("Project contract").fill("0x00000000000000000000000000000000000000d1");
  await expect(page.getByText("There is no contract at this address.").first()).toBeVisible();

  await page.getByLabel("Project contract").fill(await deployProject());
  await page.getByLabel("Project name").fill("<b>bold</b>");
  await page.getByLabel("One-line summary").fill("Summary");
  await page.getByLabel("Ask").fill("100");
  await page.getByRole("button", { name: "Submit pitch" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The name can be up to 32 bytes" })).toHaveText("The name can be up to 32 bytes, without quotes, backslashes, <, > or &.");
});

test.describe("with the committee deciding", () => {
  // These speak for the partners, whose accounts every test shares, so they take turns.
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async () => {
    test.skip(test.info().project.name !== "desktop", "The partners' accounts are driven from one project only.");
    await restoreBonds();
  });

  test("accepts the terms, receives the first tranche and the badge, then the rest for the milestone", async ({ page }) => {
    const dealId = await pitchFromPage(page, "Pizza Coin");

    await vote(dealId, 3, false);
    await approve(dealId);
    await expect(page.getByTestId("deal")).toHaveAttribute("data-stage", "approved");
    await expect(page.getByRole("img", { name: /Risk and Finance Partner: Against/ }).first()).toBeVisible();

    await offer(dealId);
    await expect(page.getByText("The committee will invest 400 tUSD")).toBeVisible();
    await page.getByRole("button", { name: "Accept terms" }).click();
    await expect(page.getByText("First tranche received")).toBeVisible();
    await expect(page.getByTestId("deal")).toHaveAttribute("data-stage", "funded");
    await expect(page.getByTestId("founder")).toContainText("Received 160 tUSD");
    await expect(page.getByRole("img", { name: "Pizza Coin" })).toBeVisible();

    await page.getByLabel("What you did").fill("The payment page is live and both shops have taken payments.");
    await page.getByLabel("Links").fill("https://example.com/pay");
    await page.getByRole("button", { name: "Submit report" }).click();
    await expect(page.getByText("Milestone reported")).toBeVisible();
    await expect(page.getByTestId("deal")).toHaveAttribute("data-stage", "milestone");
    await expect(page.getByRole("heading", { name: "Milestone review 1" })).toBeVisible();
    await expect(page.getByText("The payment page is live and both shops have taken payments.")).toBeVisible();

    await approve(dealId);
    await expect(page.getByTestId("deal")).toHaveAttribute("data-stage", "completed");
    await expect(page.getByTestId("founder")).toContainText("Received 400 tUSD");
    await expect(page.getByText("Tranche 2 paid")).toBeVisible({ timeout: 15_000 });
  });

  test("takes a visitor into the fund, whose veto shows on the big screen", async ({ page, context }) => {
    const problems = collectProblems(page);
    await page.goto("/join");
    await page.getByRole("button", { name: "Join the fund" }).click();
    const membership = page.getByTestId("membership");
    await expect(membership).toContainText("1,000");

    // The visitor held shares when the committee approved, so the veto counts them.
    const { dealId } = await pitchDirectly(site(), "Crowd Pizza");
    await approve(dealId);
    await offer(dealId);
    const row = page.locator(`[data-testid=veto][data-deal="${dealId}"]`);
    await row.getByRole("button", { name: "Propose veto" }).click();
    await expect(row.getByText(/^\d+% of the shares needed$/)).toBeVisible();

    const screen = await context.newPage();
    await screen.goto("/screen");
    await expect(screen.getByTestId("table")).toHaveAttribute("data-deal", String(dealId));
    const meter = screen.getByTestId("veto-meter");
    await expect(meter).toHaveAttribute("data-carried", "false");
    await expect(meter).toContainText("1 investor in support");
    await expect(screen.getByRole("img", { name: "Scan to invest" })).toBeVisible();
    await expect(screen.getByTestId("chain-numbers")).toContainText("Transactions");
    expect(problems).toEqual([]);
  });

  test("lets the investor veto an approved deal, which costs the approving partners part of their bonds", async ({ page }) => {
    const { dealId, founder } = await pitchDirectly(site(), "Vetoed Pizza");
    await approve(dealId);
    await vote(dealId, 3, false);
    await offer(dealId);
    await accept(founder, dealId);
    const bonds = await Promise.all([0, 1, 2, 3].map(bondOf));

    // The investor's wallet holds every share the fund issued at its start.
    await page.addInitScript((key) => {
      localStorage.setItem("onchain-vc.burner-key", key);
      localStorage.setItem("onchain-vc.burner-connected", "true");
    }, investorKey);
    await page.goto("/investors");
    const row = page.getByTestId("veto").filter({ hasText: "Vetoed Pizza" });
    await row.getByRole("button", { name: "Propose veto" }).click();
    await expect(page.getByText("Veto proposed")).toBeVisible();
    await expect(row).toHaveCount(0);

    const deal = await dealOf(dealId);
    expect(deal.stage).toBe(7);
    expect(deal.paid).toBe(160n * 10n ** 18n);
    expect(await Promise.all([0, 1, 2, 3].map(bondOf))).toEqual([bonds[0]! * 4n / 5n, bonds[1]! * 4n / 5n, bonds[2]! * 4n / 5n, bonds[3]]);

    await page.goto(`/deals/${dealId}`);
    await expect(page.getByTestId("deal")).toHaveAttribute("data-stage", "vetoed");
    await expect(page.getByText("Returned to the fund")).toBeVisible({ timeout: 15_000 });
  });
});

test("shows each partner's account and bond, and checks their published profile", async ({ page, request }) => {
  test.skip(test.info().project.name !== "desktop", "Publishing profiles signs as the partners.");
  const { profiles } = await (await request.get("/api/partners")).json() as { profiles: { name: string; profileHash: Hex }[] };
  await publishProfiles(profiles);

  await page.goto("/partners");
  await expect(page.locator("article")).toHaveCount(4);
  await expect(page.getByText("The hash on chain matches the instructions running now")).toHaveCount(4);
  const risk = page.locator("article[data-role=risk]");
  await risk.getByRole("button", { name: "Show" }).click();
  await expect(risk.getByTestId("instructions")).toContainText("风控与财务合伙人");
});

test("deposits into the fund for shares and redeems them", async ({ page }) => {
  await page.goto("/investors");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: /Burner wallet/ }).click();
  await page.getByRole("button", { name: /0x\w{4}…\w{4}$/ }).click();
  await page.getByRole("menuitem", { name: "Get test funds" }).click();
  await expect(page.getByText("Received 1 ETH")).toBeVisible();

  await page.getByRole("button", { name: "Claim tUSD" }).click();
  await expect(page.getByText("tUSD claimed")).toBeVisible();
  await page.getByLabel("Amount").fill("40");
  await page.getByRole("button", { name: "Deposit", exact: true }).click();
  await expect(page.getByText("Deposited", { exact: true })).toBeVisible();
  await expect(page.getByTestId("your-share")).not.toHaveText("0.00%");

  await page.getByRole("button", { name: "Redeem all" }).click();
  await expect(page.getByText("Redeemed", { exact: true })).toBeVisible();
  await expect(page.getByTestId("your-share")).toHaveText("0.00%");
});

test("puts the newest pitch at the table and the pitch code on the big screen", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "The big screen is for a projector.");
  await pitchDirectly(site(), "Screen Pizza");

  await page.goto("/screen");
  await expect(page.getByRole("banner")).toHaveCount(0);
  const table = page.getByTestId("table");
  // Other tests pitch at the same time, so the newest pitch need not be this test's own, and
  // the table turns to a deal investors have just moved to veto, which another test may have done.
  await expect.poll(async () => {
    const shown = await table.evaluate(element => ({
      deal: element.dataset.deal,
      name: element.querySelector("h2")?.textContent,
      contested: element.querySelector("[data-testid=veto-meter]") !== null,
    }));
    const newest = await dealCount();
    return shown.contested || (shown.deal === String(newest) && shown.name === (await dealOf(newest)).name);
  }).toBe(true);
  await expect(table.locator("article")).toHaveCount(4);

  const code = page.getByRole("img", { name: "Scan to pitch" });
  const png = await code.screenshot();
  const decoded = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return { width: image.width, height: image.height, data: [...context.getImageData(0, 0, image.width, image.height).data] };
  }, Buffer.from(png).toString("base64"));
  const result = readQr(Uint8ClampedArray.from(decoded.data), decoded.width, decoded.height);
  expect(result?.data).toBe(new URL("/pitch", page.url()).toString());
});

test("lists every pitch in the portfolio, filtered by outcome", async ({ page }) => {
  await pitchDirectly(site(), `Listed ${test.info().project.name}`);
  await page.goto("/portfolio");
  const deals = page.getByTestId("deals");
  await expect(deals.locator("li").first()).toBeVisible();
  const all = await deals.locator("li").count();

  // Other tests pitch at the same time, so the list is counted again after the filter.
  await page.getByRole("radio", { name: "In progress" }).click();
  const reviewing = await deals.locator("li").count();
  await page.getByRole("radio", { name: "All" }).click();
  expect(reviewing).toBeLessThanOrEqual(await deals.locator("li").count());
  expect(all).toBeGreaterThan(0);
  await page.getByRole("radio", { name: "In progress" }).click();
  await deals.locator("li").first().getByRole("link").click();
  await page.waitForURL(/\/deals\/\d+$/);
});

test("offers a phone without a wallet a way into one", async ({ page }) => {
  await page.goto("/investors");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  const link = page.getByRole("link", { name: /Open in MetaMask/ });

  // A phone's own browser carries no wallet, so the page offers to reopen inside MetaMask's.
  if (test.info().project.name === "phone") {
    await expect(link).toHaveAttribute("href", `https://link.metamask.io/dapp/${new URL(page.url()).host}/investors`);
  } else {
    await expect(page.getByRole("button", { name: /Burner wallet/ })).toBeVisible();
    await expect(link).toHaveCount(0);
  }
});

test("stays disconnected after the visitor disconnects", async ({ page }) => {
  await page.goto("/investors");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: /Burner wallet/ }).click();
  await page.getByRole("button", { name: /0x\w{4}…\w{4}$/ }).click();
  await page.getByRole("menuitem", { name: "Disconnect" }).click();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await expect(page.getByText("Connect a wallet to continue.")).toBeVisible();
});

test("serves a visitor without a wallet a page that knows nothing of anyone else's", async ({ page, browser }) => {
  await page.goto("/investors");
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: /Burner wallet/ }).click();
  await expect(page.getByRole("button", { name: "Redeem all" })).toBeVisible();

  const visitor = await (await browser.newContext()).newPage();
  const problems = collectProblems(visitor);
  const response = await visitor.goto("/investors");
  expect(await response!.text()).not.toContain(">Redeem all<");
  await expect(visitor.getByText("Connect a wallet to continue.")).toBeVisible();
  expect(problems).toEqual([]);
});

test("introduces the committee with figures and activity read from the chain", async ({ page }) => {
  const problems = collectProblems(page);
  const { dealId } = await pitchDirectly(site(), `Landing ${test.info().project.name}`);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("An on-chain fund run by four AI partners");
  const pitches = page.locator("dl > div", { has: page.getByText("Pitches received", { exact: true }) }).locator("dd");
  await expect.poll(async () => Number(await pitches.textContent())).toBeGreaterThanOrEqual(Number(dealId));

  const partners = page.locator("article[data-role]");
  await expect(partners).toHaveCount(4);
  await expect(partners.filter({ hasText: /Bond\s*[\d,.]+ tUSD/ })).toHaveCount(4);

  // Other tests pitch and vote at the same time, so the list is checked for what it holds rather than for this test's pitch.
  await page.getByRole("button", { name: "Founders" }).click();
  await expect(page.getByRole("button", { name: "Founders" })).toHaveAttribute("aria-pressed", "true");
  const rows = page.getByTestId("activity").locator("li");
  await expect(rows.first()).toContainText("Founders");
  await expect(rows.filter({ hasNotText: "Founders" })).toHaveCount(0);
  await rows.first().getByRole("link", { name: /^Pitch #\d+$/ }).click();
  await page.waitForURL(/\/deals\/\d+$/);

  await page.goto("/");
  await page.getByRole("link", { name: "Watch the meeting" }).first().click();
  await page.waitForURL(/\/room$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room");
  expect(problems).toEqual([]);
});

test("switches language and theme and remembers both", async ({ page }) => {
  await page.goto("/room");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Room");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("menuitem", { name: "简体中文" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("会议室");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh");

  await page.getByRole("button", { name: "设置" }).click();
  await page.getByRole("menuitem", { name: "浅色" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("会议室");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("fits every page within the width of the screen", async ({ page }) => {
  const { dealId } = await pitchDirectly(site(), `A long project name ${test.info().project.name}`);
  const problems = collectProblems(page);
  for (const path of ["/", "/room", "/pitch", "/join", "/portfolio", "/partners", "/investors", `/deals/${dealId}`]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} scrolls sideways`).toBe(0);
  }
  expect(problems).toEqual([]);
});

test("says so when a page or a pitch does not exist", async ({ page }) => {
  const response = await page.goto("/no-such-page");
  expect(response!.status()).toBe(404);
  await expect(page.getByText("Page not found")).toBeVisible();
  await page.getByRole("link", { name: "Go home" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("An on-chain fund run by four AI partners");

  // The root's loading screen is sent first, so a deal address that cannot exist answers with the page, not the status.
  await page.goto("/deals/zero");
  await expect(page.getByText("Page not found")).toBeVisible();
  await page.goto("/deals/999999");
  await expect(page.getByText("Pitch not found")).toBeVisible();
});
