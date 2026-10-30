/** Only an explicit successful {checkpoint:null} means the account has no
 * completed backup. Empty/truncated/invalid responses are never empty profiles. */
export function completedBackupSelection(value:unknown): {checkpoint:{checkpointId:string}|null} {
  const result=value as {checkpoint?:{checkpointId?:unknown}|null}|null;
  if(!result || typeof result!=='object' || !Object.hasOwn(result,'checkpoint')) throw Error('BACKUP_LATEST_RESPONSE_INVALID');
  if(result.checkpoint===null)return {checkpoint:null};
  const id=result.checkpoint?.checkpointId;
  if(typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))throw Error('BACKUP_LATEST_RESPONSE_INVALID');
  return {checkpoint:{checkpointId:id}};
}
