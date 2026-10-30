import { test, expect } from "@playwright/test";

const image = (name: string) => `evidence/atlas-v21/account-states/${name}.png`;
test("checking stays neutral until the actual sign-in state resolves", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/hub/state", async (route) => {
    await pending;
    await route.fulfill({ json: { enabled: true, authenticated: false, branchAvailable: true, hubOrigin: "http://localhost:4180" } });
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Opening Atlas", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start empty instead", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
  await page.screenshot({ path: image("checking"), animations: "disabled" });
  release();
  await expect(page.getByRole("heading", { name: "Welcome to Atlas" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await expect(page.getByRole("link", { name: "Open Atlas Hub" })).toHaveAttribute("href", "http://localhost:4180");
  await page.screenshot({ path: image("signed-out"), animations: "disabled" });
});
for (const width of [1440, 390, 320]) {
  test(`unavailable link offers Hub without clipped controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route("**/api/hub/state", (route) => route.fulfill({ json: { enabled: true, authenticated: false, branchAvailable: false, hubOrigin: "http://localhost:4180" } }));
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "This link is unavailable" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
    const link = page.getByRole("link", { name: "Open Atlas Hub" });
    await expect(link).toBeVisible();
    const bounds = (await link.boundingBox())!;
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: image(`unavailable-${width}`), animations: "disabled" });
  });
}
test("failed startup keeps a readable retry action without an import promise", async ({ page }) => {
  await page.route("**/api/hub/state", (route) => route.fulfill({ status: 503, json: { error: "fixture unavailable" } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Atlas could not open" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("temporarily unavailable");
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Start empty instead", exact: true })).toHaveCount(0);
  await page.screenshot({ path: image("startup-error"), animations: "disabled" });
});


test("entry phases keep the same card and do not flash menus during sign-in", async ({ page }) => {
  let resolveState!: () => void;
  const stateHeld=new Promise<void>(r=>{resolveState=r});
  let resolveSignin!: () => void;
  const signinHeld=new Promise<void>(r=>{resolveSignin=r});
  await page.route("**/api/hub/state",async route=>{await stateHeld;await route.fulfill({json:{enabled:true,authenticated:false,branchAvailable:true,hubOrigin:"http://localhost:4180"}})});
  await page.route("**/api/hub/signin",async route=>{await signinHeld;await route.fulfill({status:503,json:{error:"Synthetic sign-in failure"}})});
  await page.goto("/",{waitUntil:"domcontentloaded"});
  const card=page.locator("[data-entry-card][data-entry-react]");await expect(card).toBeVisible();
  await card.evaluate(el=>{(el as HTMLElement).dataset.originalEntry="yes"});
  await expect(page.getByRole("heading",{name:"Opening Atlas",exact:true})).toBeVisible();
  await page.screenshot({path:"evidence/atlas-v21/review-fixes-20261021/loading/checking.png",animations:"disabled"});
  resolveState();await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Opening Atlas",exact:true})).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Signing you in");
  await expect(card).toHaveAttribute("data-original-entry","yes");
  for(const name of ["Sign in","Retry","Sign out","Skip import"])await expect(page.getByRole("button",{name,exact:true})).toHaveCount(0);
  await expect(page.getByRole("link",{name:"Open Atlas Hub",exact:true})).toHaveCount(0);
  await page.screenshot({path:"evidence/atlas-v21/review-fixes-20261021/loading/signing-in.png",animations:"disabled"});
  resolveSignin();await expect(page.getByRole("alert")).toContainText("Synthetic sign-in failure");
  await expect(page.getByRole("button",{name:"Sign in",exact:true})).toBeEnabled();
  await expect(card).toHaveAttribute("data-original-entry","yes");
});
