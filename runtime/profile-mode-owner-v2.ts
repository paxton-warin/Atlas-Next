/** Site-by-site compatibility routing. A deferred legacy site keeps the legacy
 * actor; it cannot revoke a ready v2 actor or pretend to have migrated. */
export function createProfileModeOwnerV2<
  T extends {
    readonly live: boolean;
    bind(input: any): Promise<any>;
    dispose(): void;
  },
>(
  local: () => Promise<T>,
  legacy: () => Promise<T>,
  isLocal: (url: string) => boolean,
): T {
  let live = true;
  const owners = new Map<boolean, Promise<T>>();
  function get(url: string) {
    if (!live) return Promise.reject(new Error("PROFILE_OWNER_DISPOSED"));
    const mode = isLocal(url);
    let actor = owners.get(mode);
    if (!actor) {
      actor = (mode ? local() : legacy())
        .then((value) => {
          if (!live) {
            value.dispose();
            throw new Error("PROFILE_OWNER_DISPOSED");
          }
          return value;
        })
        .catch((error) => {
          owners.delete(mode);
          throw error;
        });
      owners.set(mode, actor);
    }
    return actor;
  }
  return {
    get live() {
      return live;
    },
    async bind(input: any) {
      return (await get(input.website)).bind(input);
    },
    async getRequestHeader(context: any) {
      return ((await get(context.documentURL)) as any).getRequestHeader(
        context,
      );
    },
    async storeResponseCookies(lines: string[], context: any) {
      return ((await get(context.documentURL)) as any).storeResponseCookies(
        lines,
        context,
      );
    },
    dispose() {
      if (!live) return;
      live = false;
      for (const actor of owners.values())
        void actor.then((value) => value.dispose()).catch(() => {});
      owners.clear();
    },
  } as unknown as T;
}
