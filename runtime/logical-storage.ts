/** Repairs the pinned engine's Web Storage API semantics without changing its
 * cookie jar or vendor assets. Native stores remain on the current frontend;
 * every website-visible namespace is the exact logical HTTP(S) origin. */
type Owner = Window & typeof globalThis;
type Store = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;

export function createLogicalStorage(
  native: Store,
  origin: string,
  prototype: object = Object.prototype,
): Storage {
  origin = new URL(origin).origin;
  const prefix = origin + "@";
  const keys = () => {
    const result: string[] = [];
    for (let index = 0; index < native.length; index++) {
      const name = native.key(index);
      if (name?.startsWith(prefix)) result.push(name.slice(prefix.length));
    }
    return result;
  };
  // Upgrade old host-only saves once, non-destructively. New values always win;
  // clear() never reimports the legacy save or touches frontend preferences.
  const migrated = "__atlas.logicalStorage.v1@" + origin;
  if (native.getItem(migrated) === null) {
    const legacy = new URL(origin).host + "@";
    const copies: [string, string][] = [];
    for (let index = 0; index < native.length; index++) {
      const name = native.key(index);
      if (name?.startsWith(legacy)) {
        const value = native.getItem(name);
        if (value !== null) copies.push([name.slice(legacy.length), value]);
      }
    }
    for (const [name, value] of copies)
      if (native.getItem(prefix + name) === null)
        native.setItem(prefix + name, value);
    native.setItem(migrated, "1");
  }
  const methods: Record<string, (...args: any[]) => any> = {
    getItem: (key: unknown) => native.getItem(prefix + String(key)),
    setItem: (key: unknown, value: unknown) =>
      native.setItem(prefix + String(key), String(value)),
    removeItem: (key: unknown) => native.removeItem(prefix + String(key)),
    clear: () => {
      for (const key of keys()) native.removeItem(prefix + key);
    },
    key: (index: number) => keys()[Number(index) >>> 0] ?? null,
  };
  return new Proxy(Object.create(prototype), {
    get(_target, property) {
      if (property === "length") return keys().length;
      if (property === Symbol.toStringTag) return "Storage";
      if (typeof property === "symbol") return Reflect.get(prototype, property);
      if (Object.hasOwn(methods, property)) return methods[property];
      if (property in Object.prototype) return Reflect.get(prototype, property);
      return methods.getItem(property) ?? undefined;
    },
    set(_target, property, value) {
      if (typeof property !== "string") return false;
      methods.setItem(property, value);
      return true;
    },
    deleteProperty(_target, property) {
      if (typeof property === "string") methods.removeItem(property);
      return true;
    },
    has(_target, property) {
      return (
        typeof property === "string" &&
        (property === "length" ||
          Object.hasOwn(methods, property) ||
          native.getItem(prefix + property) !== null)
      );
    },
    ownKeys: () => keys(),
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property !== "string") return;
      const value = native.getItem(prefix + property);
      if (value === null) return;
      return { configurable: true, enumerable: true, writable: true, value };
    },
    defineProperty(_target, property, descriptor) {
      if (typeof property !== "string" || !("value" in descriptor))
        return false;
      methods.setItem(property, descriptor.value);
      return true;
    },
  }) as Storage;
}

function captureStore(win: Owner, store: Storage): Store {
  const prototype = win.Storage.prototype;
  const length = Object.getOwnPropertyDescriptor(prototype, "length")!.get!;
  return {
    getItem: prototype.getItem.bind(store),
    setItem: prototype.setItem.bind(store),
    removeItem: prototype.removeItem.bind(store),
    key: prototype.key.bind(store),
    get length() {
      return length.call(store);
    },
  };
}

export function createLogicalStoragePlugin(globals: any) {
  const snapshots = new WeakMap<
    object,
    {
      local: Store;
      session: Store;
      idb: IDBFactory;
      open: IDBFactory["open"];
      remove: IDBFactory["deleteDatabase"];
      databases?: IDBFactory["databases"];
      caches?: CacheStorage;
      cacheOpen?: CacheStorage["open"];
      cacheHas?: CacheStorage["has"];
      cacheDelete?: CacheStorage["delete"];
      cacheKeys?: CacheStorage["keys"];
    }
  >();
  const { ManagedPlugin } = globals.$runtimekitController;
  return new (class extends ManagedPlugin {
    constructor() {
      super("atlas-logical-storage", []);
    }
    install(frame: any) {
      super.install(frame);
      this.tap(frame.hooks.init.pre, ({ window: win, client }: any) => {
        const idb = win.indexedDB as IDBFactory;
        const caches = win.caches as CacheStorage | undefined;
        snapshots.set(client, {
          local: captureStore(win, win.localStorage),
          session: captureStore(win, win.sessionStorage),
          idb,
          open: idb.open.bind(idb),
          remove: idb.deleteDatabase.bind(idb),
          databases: idb.databases?.bind(idb),
          caches,
          cacheOpen: caches?.open.bind(caches),
          cacheHas: caches?.has.bind(caches),
          cacheDelete: caches?.delete.bind(caches),
          cacheKeys: caches?.keys.bind(caches),
        });
      });
      this.tap(frame.hooks.init.post, ({ window: win, client }: any) => {
        const native = snapshots.get(client);
        if (!native) return;
        const origin = new URL(client.url.href).origin;
        if (!/^https?:\/\//.test(origin)) return;
        const prefix = origin + "@";
        const define = (target: object, key: string, value: unknown) =>
          Object.defineProperty(target, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value,
          });
        define(
          win,
          "localStorage",
          createLogicalStorage(native.local, origin, win.Storage.prototype),
        );
        define(
          win,
          "sessionStorage",
          createLogicalStorage(native.session, origin, win.Storage.prototype),
        );
        // The engine already scopes IDB.open and DB.name. Replace open with the
        // captured native method so names are prefixed once, including deletion.
        define(native.idb, "open", (name: unknown, ...version: [number?]) =>
          native.open(prefix + String(name), ...version),
        );
        define(native.idb, "deleteDatabase", (name: unknown) =>
          native.remove(prefix + String(name)),
        );
        if (native.databases)
          define(native.idb, "databases", async () =>
            (await native.databases!())
              .filter((entry) => entry.name?.startsWith(prefix))
              .map((entry) => ({
                ...entry,
                name: entry.name!.slice(prefix.length),
              })),
          );
        if (
          native.caches &&
          native.cacheOpen &&
          native.cacheHas &&
          native.cacheDelete &&
          native.cacheKeys
        ) {
          define(native.caches, "open", (name: unknown) =>
            native.cacheOpen!(prefix + String(name)),
          );
          define(native.caches, "has", (name: unknown) =>
            native.cacheHas!(prefix + String(name)),
          );
          define(native.caches, "delete", (name: unknown) =>
            native.cacheDelete!(prefix + String(name)),
          );
          define(native.caches, "keys", async () =>
            (await native.cacheKeys!())
              .filter((name) => name.startsWith(prefix))
              .map((name) => name.slice(prefix.length)),
          );
        }
      });
    }
  })();
}
