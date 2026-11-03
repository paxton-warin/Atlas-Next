/** Optional, bounded credit for atomically replacing this replica's old head.
 * The proof's catalog/part scan is performed BEFORE the account publication lock. */
import type {PoolClient} from 'pg';
import {AppError} from './errors.js';
export async function stageReplacementProof(c:PoolClient,profileId:string,id:string){
 const cp=(await c.query('SELECT * FROM hub_backup_checkpoints WHERE profile_id=$1 AND checkpoint_id=$2 FOR UPDATE',[profileId,id])).rows[0];if(!cp||cp.receipt||cp.status!=='prepared'||!cp.catalog_ready)return;
 let hashes:string[]=[];
 if(cp.parent_checkpoint_id)hashes=(await c.query('SELECT old.hash FROM hub_backup_checkpoint_parts old JOIN hub_backup_parts p USING(profile_id,hash) WHERE old.profile_id=$1 AND old.checkpoint_id=$2 AND old.ref_held AND p.published_refs=1 AND NOT EXISTS(SELECT 1 FROM hub_backup_checkpoint_parts current WHERE current.profile_id=old.profile_id AND current.checkpoint_id=$3 AND current.hash=old.hash) ORDER BY old.hash LIMIT 64',[profileId,cp.parent_checkpoint_id,id])).rows.map(x=>x.hash);
 await c.query('UPDATE hub_backup_checkpoints SET replacement_proof=$3 WHERE profile_id=$1 AND checkpoint_id=$2',[profileId,id,{parent:cp.parent_checkpoint_id,hashes}]);
}
/** Caller holds profile→replica→candidate locks. No catalog scan is performed here. */
export async function applyAtomicReplacementCredit(c:PoolClient,o:{profileId:string;replicaId:string;candidate:any;headId:string|null;adoptedThrough:number;requiredBytes:number;migrationCredit:number}){
 const proof=o.candidate.replacement_proof;
 if(!o.headId||o.migrationCredit!==0||proof?.parent!==o.headId||!Array.isArray(proof.hashes)||proof.hashes.length>64||!proof.hashes.length)return 0;
 const old=(await c.query('SELECT * FROM hub_backup_checkpoints WHERE profile_id=$1 AND checkpoint_id=$2 FOR UPDATE',[o.profileId,o.headId])).rows[0];
 if(!old||old.status!=='complete'||Number(old.catalog_version)!==1||old.replica_id!==o.replicaId||Number(old.sequence)>o.adoptedThrough)return 0;
 const protectedHead=(await c.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM hub_backup_replicas r WHERE r.profile_id=$1 AND r.deleted_at IS NULL AND(r.replica_id<>$4 AND r.head_checkpoint_id=$2 OR r.seed_checkpoint_id=$2 AND r.head_checkpoint_id IS NULL)) OR EXISTS(SELECT 1 FROM hub_backup_catalog_pins pin JOIN hub_backup_checkpoints owner ON owner.profile_id=pin.profile_id AND owner.checkpoint_id=pin.owner_checkpoint_id WHERE pin.profile_id=$1 AND pin.parent_checkpoint_id=$2 AND pin.owner_checkpoint_id<>$3 AND owner.status='prepared' AND owner.expires_at>now()) OR EXISTS(SELECT 1 FROM hub_backup_restore_pins pin WHERE pin.profile_id=$1 AND pin.checkpoint_id=$2 AND pin.expires_at>now())`,[o.profileId,o.headId,o.candidate.checkpoint_id,o.replicaId])).rowCount;
 if(protectedHead)return 0;
 const rows=(await c.query('SELECT p.hash,p.bytes FROM hub_backup_parts p JOIN hub_backup_checkpoint_parts old USING(profile_id,hash) WHERE p.profile_id=$1 AND old.checkpoint_id=$2 AND old.ref_held AND p.hash=ANY($3::text[]) AND p.published_refs=1 AND NOT EXISTS(SELECT 1 FROM hub_backup_checkpoint_parts current WHERE current.profile_id=p.profile_id AND current.checkpoint_id=$4 AND current.hash=p.hash) ORDER BY p.hash FOR UPDATE OF p',[o.profileId,o.headId,proof.hashes,o.candidate.checkpoint_id])).rows;
 const selected:any[]=[];let freed=0;for(const row of rows){selected.push(row);freed+=Number(row.bytes);if(freed>=o.requiredBytes)break;}
 if(freed<o.requiredBytes)return 0;
 const hashes=selected.map(x=>x.hash),changed=await c.query('UPDATE hub_backup_parts SET published_refs=0,ever_published=true,gc_eligible_at=now() WHERE profile_id=$1 AND hash=ANY($2::text[]) AND published_refs=1',[o.profileId,hashes]);
 if(changed.rowCount!==hashes.length)throw new AppError('BACKUP_CONFLICT','The bounded replacement credit changed; local saves are retained.',409);
 await c.query('UPDATE hub_backup_checkpoint_parts SET ref_held=false WHERE profile_id=$1 AND checkpoint_id=$2 AND hash=ANY($3::text[])',[o.profileId,o.headId,hashes]);
 await c.query("UPDATE hub_backup_checkpoints SET status='retired',catalog_released=NOT EXISTS(SELECT 1 FROM hub_backup_checkpoint_parts WHERE profile_id=$1 AND checkpoint_id=$2 AND ref_held) WHERE profile_id=$1 AND checkpoint_id=$2",[o.profileId,o.headId]);
 await c.query('UPDATE hub_profiles SET backup_v2_bytes=backup_v2_bytes-$2,backup_v2_staging_bytes=backup_v2_staging_bytes+$2,backup_v2_staging_parts=backup_v2_staging_parts+$3,bytes=backup_v1_canonical_bytes+GREATEST(0,backup_v2_bytes-$2-backup_v2_migration_credit) WHERE id=$1',[o.profileId,freed,hashes.length]);
 return freed;
}
