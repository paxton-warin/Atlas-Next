import type {BackupRestoreProgress} from '../../runtime/backup-v2-restore.ts';
/** Byte-weighted applied work, not a timer animation. ETA excludes unknown
 * planning work and never reports success before the catalog is published. */
export function restorePresentation(progress:BackupRestoreProgress) {
  const p=progress;
  const known=Number.isSafeInteger(p.totalBytes)&&p.totalBytes!>0;
  const ratio=known?Math.min(1,Math.max(0,p.completedBytes/p.totalBytes!)):0;
  const percent=p.phase==='ready'?100:p.phase==='finalizing'?99:known?Math.floor(ratio*98):undefined;
  const labels={discovering:'Finding your latest backup…',planning:'Checking backup contents…',restoring:'Restoring your saved browser…',finalizing:'Finishing your restore…',ready:'Your browser is ready',error:'Restore paused'};
  let eta:string|undefined;
  if(p.phase==='restoring'&&known&&p.elapsedMs>=1000&&p.completedBytes>0&&ratio>=.02&&ratio<1){
    const seconds=Math.max(1,Math.ceil((p.elapsedMs/1000)*(1-ratio)/ratio));
    eta=seconds<60?`About ${seconds<10?seconds:Math.ceil(seconds/5)*5} seconds remaining`:`About ${Math.ceil(seconds/60)} minutes remaining`;
  }else if(p.phase==='restoring'&&ratio<1)eta='Calculating time remaining…';
  return {percent,label:labels[p.phase],eta};
}
