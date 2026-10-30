/** Window/profile/lease-scoped owner reuse. Document capabilities and session
 * namespaces remain independent; workers are sharded before their existing
 * 32-document limit, and the last lease alone retires the underlying owners. */
type Binding = { dispose(): void };
type Owner = { readonly live: boolean; bind(options: any): Promise<Binding>; dispose(): void };
type Member = { owner?: Owner; flight: Promise<Owner>; used: number };
type Pool = { refs: number; live: boolean; members: Member[] };
const windows = new WeakMap<object, Map<string, Pool>>();
export function acquireSharedProfileOwner<T extends Owner>(
  window: object, key: string, create: () => Promise<T>, capacity = 32,
): T {
  let pools = windows.get(window);
  if (!pools) { pools = new Map(); windows.set(window, pools); }
  let pool = pools.get(key);
  if (!pool) { pool = { refs: 0, live: true, members: [] }; pools.set(key, pool); }
  pool.refs++;
  const current = pool;
  let live = true;
  async function member(binding: boolean) {
    if (!live || !current.live) throw new Error('PROFILE_OWNER_LEASE_DISPOSED');
    current.members = current.members.filter(e => e.owner?.live !== false);
    let entry = current.members.find(e => e.owner?.live !== false && (!binding || e.used < capacity));
    if (!entry) {
      const next = { used: 0 } as Member;
      next.flight = Promise.resolve().then(create).then(owner => {
        next.owner = owner;
        if (!current.live) { owner.dispose(); throw new Error('PROFILE_OWNER_POOL_DISPOSED'); }
        return owner;
      }).catch(error => { current.members = current.members.filter(e => e !== next); throw error; });
      current.members.push(next); entry = next;
    }
    if (binding) entry.used++;
    try { const owner = await entry.flight; if (!live) throw new Error('PROFILE_OWNER_LEASE_DISPOSED'); return { entry, owner: owner as T }; }
    catch (error) { if (binding) entry.used--; throw error; }
  }
  const call = async (name: string, args: any[]) => {
    const { owner } = await member(false);
    return (owner as any)[name](...args);
  };
  return {
    get live() { return live && current.live; },
    async bind(options: any) {
      const { entry, owner } = await member(true);
      try {
        const bound = await owner.bind(options);
        if (!live) { bound.dispose(); throw new Error('PROFILE_OWNER_LEASE_DISPOSED'); }
        let attached = true;
        return { ...bound, dispose() { if (!attached) return; attached = false; entry.used--; bound.dispose(); } };
      } catch (error) { entry.used--; throw error; }
    },
    getRequestHeader(...args: any[]) { return call('getRequestHeader', args); },
    storeResponseCookies(...args: any[]) { return call('storeResponseCookies', args); },
    dispose() {
      if (!live) return; live = false;
      if (--current.refs) return;
      current.live = false; pools!.delete(key);
      for (const member of current.members) member.owner?.dispose();
      current.members = [];
    },
  } as unknown as T;
}
