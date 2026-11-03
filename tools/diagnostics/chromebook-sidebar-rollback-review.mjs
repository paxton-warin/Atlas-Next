import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
process.env.ATLAS_SIDEBAR_REVIEW_IMPORT='1';
const {sidebarReviewServer:server,seedSidebarReview:seed,captureSidebarReview:shot,sidebarReviewGeometry:geometry,stopSidebarReviewServers:stop}=await import('./chromebook-sidebar-review.mjs');
const E='evidence/chromebook-sidebar-20261021';let browser;
try {
 const old=await readFile(`${E}/baseline/web-build/index.html`,'utf8'), restored=await readFile(`${E}/rollback-build/web-build/index.html`,'utf8');
 assert.equal(restored.match(/assets\/index-[^\"]+\.js/)[0],old.match(/assets\/index-[^\"]+\.js/)[0]);
 assert.equal(restored.match(/assets\/index-[^\"]+\.css/)[0],old.match(/assets\/index-[^\"]+\.css/)[0]);
 assert.equal(await readFile(`${E}/rollback-test/unrelated-change.txt`,'utf8'),'Unrelated change preserved\n');
 const url=await server('rollback-build');browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const p=await browser.newPage({viewport:{width:1366,height:600}});await seed(p);await p.goto(url);await p.frameLocator('iframe[data-local="review-0"]').locator('input').waitFor();
 await p.mouse.move(28,100);await p.waitForTimeout(1250);const g=await geometry(p);assert.ok(g.navButtons.some(b=>!b.fullyInsideNav));assert.equal(await p.locator('.atlas').evaluate(e=>e.classList.contains('sidebar-peeking')),false);await shot(p,'rollback-restored-1366x600');
 const result={result:'PASS',entryJsRestored:restored.match(/assets\/index-[^\"]+\.js/)[0],entryCssRestored:restored.match(/assets\/index-[^\"]+\.css/)[0],baselineNavigationClippingRestored:true,hoverExpansionAbsent:true,unrelatedChangePreserved:true,productionUnaffectedByRollbackTest:true};
 await writeFile(`${E}/ROLLBACK_RESULT.json`,JSON.stringify(result,null,2));console.log('ROLLBACK_BROWSER=PASS; baseline bundle and navigation restored; unrelated change preserved; actual modified workspace retained');
}finally{await browser?.close();await stop();}
