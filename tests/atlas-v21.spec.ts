import { test, expect, type Page } from "@playwright/test";
const fixture = "http://127.0.0.1:4199/fixture";
async function seed(page: Page, width=1440, height=900) {
  await page.setViewportSize({width,height});
  await page.addInitScript(() => {
    if (window !== top) return;
    localStorage.setItem("atlas.onboarded", "true");
    localStorage.setItem("atlas.sidebarCollapsed", "false");
    localStorage.setItem("atlas.settings", JSON.stringify({theme:"forest", mode:"dark", motion:false, tabs:"sidebar", restore:true}));
  });
  await page.goto("/");
  await expect(page.locator("body")).toHaveClass(/atlas-v21/);
  await expect(page.getByLabel("Search the web")).toBeVisible();
}
async function navigate(page:Page, name:string) {
  const menu=page.getByRole("button",{name:"Menu",exact:true});
  if((page.viewportSize()?.width || 1440)<600)await expect(menu).toBeVisible();
  if(await menu.isVisible() && await menu.getAttribute("aria-expanded")!=="true")await menu.click();
  await page.getByRole("navigation",{name:"Atlas pages"}).getByRole("button",{name,exact:true}).click();
}
async function capture(page:Page,name:string) {
  await page.evaluate(async()=>{await document.fonts.ready; await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`evidence/atlas-v21/${name}.png`,fullPage:true});
}
test("visual shell transitions retain the live website context, draft and lease",async({page})=>{
  await seed(page);
  await page.getByLabel("Search the web").fill(fixture);
  await page.getByLabel("Search the web").press("Enter");
  const runtime=page.locator('iframe[title="Atlas isolated browsing runtime"]');
  const website=page.frameLocator('iframe[title="Atlas isolated browsing runtime"]').frameLocator('iframe[title="Proxied website"]');
  await expect(website.getByRole("heading",{name:"Proxy fixture ready"})).toBeVisible();
  await website.locator('input[name="message"]').fill("V2.1 keeps this live draft");
  await website.locator("body").evaluate(el=>el.dataset.v21Lifetime="retained");
  await runtime.evaluate(el=>(window as any).__v21Runtime=el);
  const before=await runtime.getAttribute("src");
  const lease=await page.evaluate(()=>localStorage.getItem("atlas.nodeSession"));
  const navigations:string[]=[];
  page.on("framenavigated",frame=>{if(frame!==page.mainFrame())navigations.push(frame.url());});
  const allocations:string[]=[];
  page.on("request",request=>{if(request.method()==="POST"&&request.url().endsWith("/api/browse/session")){const body=request.postDataJSON();if(body.intent!=="renew")allocations.push(body.intent||"unspecified");}});
  await page.getByRole("button",{name:"Collapse tabs",exact:true}).click();
  await page.getByRole("button",{name:"Expand tabs",exact:true}).click();
  await page.getByRole("button",{name:"Connection options",exact:true}).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button",{name:"Enter focus mode",exact:true}).click();
  await page.getByRole("button",{name:"Exit focus mode",exact:true}).click();
  await navigate(page,"Games");
  await navigate(page,"Settings");
  await page.getByRole("button",{name:"Theme Iris",exact:true}).click();
  await page.locator(".settings-nav").getByRole("button",{name:"Browser",exact:true}).click();
  await page.getByRole("button",{name:/Top tabs/}).click();
  await navigate(page,"Browser");
  await page.setViewportSize({width:390,height:844});
  await page.getByRole("button",{name:"Menu",exact:true}).click();
  await page.keyboard.press("Escape");
  await page.setViewportSize({width:1440,height:900});
  expect(await runtime.evaluate(el=>el===(window as any).__v21Runtime)).toBe(true);
  expect(await runtime.getAttribute("src")).toBe(before);
  expect(await page.evaluate(()=>localStorage.getItem("atlas.nodeSession"))).toBe(lease);
  await expect(website.locator('input[name="message"]')).toHaveValue("V2.1 keeps this live draft");
  await expect(website.locator("body")).toHaveAttribute("data-v21-lifetime","retained");
  expect(navigations).toEqual([]);
  expect(allocations).toEqual([]);
  await capture(page,"lifetime-top-tabs");
});
for(const [width,height] of [[1440,900],[1366,768],[768,1024],[390,844],[320,700]]) {
  test(`presentation surfaces fit ${width}px and retain all settings destinations`,async({page})=>{
    await seed(page,width,height);
    await capture(page,`home-${width}`);
    for(const destination of ["Games","Apps","Settings","AI"]) {
      await navigate(page,destination);
      if(destination==="AI")await expect(page.getByRole("heading",{name:"What can I help with?",exact:true})).toBeVisible();
      await capture(page,`${destination.toLowerCase()}-${width}`);
    }
    await navigate(page,"Settings");
    for(const section of ["Appearance","Browser","Tab & icon","Privacy & data"]) {
      await page.locator(".settings-nav").getByRole("button",{name:section,exact:true}).click();
      if(section==="Browser") {
        await expect(page.locator(".layout-diagram.sidebar")).toHaveCSS("position","relative");
        const diagram=(await page.locator(".layout-diagram.sidebar").boundingBox())!;
        const card=(await page.getByRole("button",{name:/Sidebar tabs/}).boundingBox())!;
        expect(diagram.x).toBeGreaterThanOrEqual(card.x);
        expect(diagram.x+diagram.width).toBeLessThanOrEqual(card.x+card.width);
      }
      await capture(page,`settings-${section.toLowerCase().replaceAll(/[^a-z]+/g,"-")}-${width}`);
    }
    await page.locator(".settings-nav").getByRole("button",{name:/Reopen welcome wizard/}).click();
    await expect(page.getByRole("dialog",{name:"Welcome to Atlas"})).toBeVisible();
    await capture(page,`setup-${width}`);
    await page.getByRole("button",{name:"Use defaults",exact:true}).click();
    await page.goto("/support");
    await expect(page.getByRole("combobox").filter({visible:true})).toHaveCount(1);
    await expect(page.locator(".honeypot")).toHaveAttribute("aria-hidden", "true");
    await expect(page.locator(".honeypot input")).toHaveAttribute("tabindex", "-1");
    expect((await page.locator(".honeypot").boundingBox())!.x).toBeLessThan(0);
    await capture(page,`legacy-support-${width}`);
  });
}
for (const game of ["2048","snake","tic"]) {
  test(`owned ${game} keeps its original rules and usable controls`,async({page})=>{
    await page.setViewportSize({width:540,height:720});
    await page.goto(`/games/${game}.html`);
    await expect(page.getByRole("button",{name:"New game",exact:true})).toBeVisible();
    if(game==="tic") {
      await expect(page.locator("#instructions")).toContainText("Two players");
      await page.getByRole("button",{name:"Cell 1",exact:true}).click();
      await expect(page.getByRole("button",{name:"Cell 1",exact:true})).toHaveText("X");
      await expect(page.locator("#status")).toHaveText("O to play");
      await page.getByRole("button",{name:"Cell 2",exact:true}).click();
      await expect(page.getByRole("button",{name:"Cell 2",exact:true})).toHaveText("O");
      await expect(page.locator("#status")).toHaveText("X to play");
    } else if(game==="2048") {
      await expect(page.locator(".cell")).toHaveCount(16);
      await expect(page.locator(".cell.filled")).toHaveCount(2);
      await page.keyboard.press("ArrowLeft");
      await expect(page.locator("#status")).toContainText("Score");
    } else {
      await expect(page.locator("canvas")).toBeVisible();
      await page.keyboard.press("Space");
      await expect(page.locator("#status")).toContainText("Paused");
      for(const arrow of ["←","↑","↓","→"])await expect(page.getByRole("button",{name:arrow,exact:true})).toBeVisible();
    }
    await capture(page,`game-${game}`);
  });
}
test("coarse mobile targets are at least 44px without toolbar overlaps",async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  const page=await context.newPage();
  try {
    await seed(page,390,844);
    for(const locator of [page.locator('.topbar .brand'),page.getByRole('button',{name:'Menu',exact:true}),page.getByRole('button',{name:'Toggle color mode',exact:true}),page.getByRole('button',{name:'Connection options',exact:true}),page.locator('.hero-search>button'),page.getByRole('button',{name:'Customize',exact:true})]) {
      const box=(await locator.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await capture(page,'coarse-home-390');
    await page.getByLabel('Search the web').fill(fixture);
    await page.getByLabel('Search the web').press('Enter');
    await expect(page.frameLocator('iframe[title="Atlas isolated browsing runtime"]').frameLocator('iframe[title="Proxied website"]').getByRole('heading',{name:'Proxy fixture ready'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Enter focus mode',exact:true})).toBeVisible();
    const boxes=await page.locator('.browser-toolbar .icon-button,.browser-toolbar .browsing-options-trigger,.browser-toolbar input').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().toJSON()));
    for(const b of boxes){expect(b.width).toBeGreaterThanOrEqual(44);expect(b.height).toBeGreaterThanOrEqual(44);expect(b.x).toBeGreaterThanOrEqual(0);expect(b.right).toBeLessThanOrEqual(390);}
    for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];expect(Math.max(0,Math.min(a.right,b.right)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y))).toBe(0);}
    await capture(page,'coarse-browser-390');
  } finally {await context.close();}
});

test("inline dialogs contain keyboard focus, dismiss and restore their opener without changing preferences",async({page})=>{
  await seed(page);
  const before=await page.evaluate(()=>({settings:localStorage.getItem('atlas.settings'),shortcuts:localStorage.getItem('atlas.shortcuts')}));
  const opener=page.getByRole('button',{name:'Add shortcut',exact:true});
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog',{name:'Add shortcut',exact:true});
  await expect(dialog.getByRole('textbox',{name:'Name',exact:true})).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button',{name:'Close dialog',exact:true})).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button',{name:'Add shortcut',exact:true})).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button',{name:'Close dialog',exact:true})).toBeFocused();
  await dialog.getByRole('textbox',{name:'Name',exact:true}).fill('Unsaved shortcut');
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('textbox',{name:'Website',exact:true})).toBeFocused();
  await capture(page,'shortcut-keyboard-focus');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  const history=page.getByRole('button',{name:'Recently visited',exact:true});
  await history.click();
  const historyDialog=page.getByRole('dialog',{name:'Browsing history',exact:true});
  await expect(historyDialog.getByRole('button',{name:'Close history'})).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await historyDialog.evaluate(el=>el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(historyDialog).toHaveCount(0);
  await expect(history).toBeFocused();
  expect(await page.evaluate(()=>({settings:localStorage.getItem('atlas.settings'),shortcuts:localStorage.getItem('atlas.shortcuts')}))).toEqual(before);
});
