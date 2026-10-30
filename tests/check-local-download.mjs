import fs from 'node:fs/promises';
const r=JSON.parse(await fs.readFile(process.argv[2],'utf8'));const failures=[];
if(!r.rows?.length||r.direct?.length!==r.rows.length)failures.push('missing/mismatched cases');
for(const c of r.direct)if(c.failure!==null||!c.bytesMatch)failures.push(`direct ${c.case}: control failed`);
for(const c of r.rows){if(c.downloadStarted!==true||c.failure!==null||c.bytesMatch!==true||c.filename!=='atlas-fixture.txt'||c.nativeChromeTabs!==0||c.downloadCount!==1||c.fixtureErrors?.length||c.errors?.length)failures.push(`Atlas ${c.case}: download failed (${c.failure??'no download'})`)}
if(r.pins.length!==r.rows.length||r.pins.some(x=>!x.matches))failures.push('runtime asset pin mismatch');
if(failures.length){console.error('DOWNLOAD_CHECK FAIL cases='+r.rows.length+' failures='+failures.length+'\n'+failures.join('\n'));process.exitCode=1}else console.log('DOWNLOAD_CHECK PASS cases='+r.rows.length+' bytes=preserved filename=preserved nativeChromeTabs=0 assetPins=matched');
