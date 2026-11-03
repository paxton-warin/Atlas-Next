export async function collectEmails(load: (page: number) => Promise<{users: {id:string;email:string}[];pagination:{page:number;total:number;totalPages:number}}>) {
  const emails = new Map<string,string>();
  let total = -1;
  for (let page=1; ;page++) {
    const result = await load(page);
    if (result.pagination.page !== page || (total >= 0 && total !== result.pagination.total)) throw Error("Accounts changed during export. Retry.");
    total = result.pagination.total;
    for (const user of result.users) {
      if (emails.has(user.id)) throw Error("Accounts changed during export. Retry.");
      if (/[\r\n]/.test(user.email)) throw Error("Invalid account email.");
      emails.set(user.id,user.email);
    }
    if (page >= result.pagination.totalPages) break;
  }
  if (emails.size !== total) throw Error("Incomplete account export. Retry.");
  return [...emails.values()].sort().join("\n") + (emails.size ? "\n" : "");
}
export async function deleteSnapshot(ids: string[], remove: (id:string)=>Promise<unknown>, progress:(n:number)=>void, pause:()=>Promise<void>) {
  if (new Set(ids).size !== ids.length || ids.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw Error("Invalid link snapshot.");
  let count=0;
  for (const id of ids) {
    await pause();
    await remove(id);
    progress(++count);
  }
  return count;
}
