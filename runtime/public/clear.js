(async () => {
  const config = await fetch("/runtime-config", {
    headers: {
      authorization:
        "Bearer " +
        (new URLSearchParams(location.hash.slice(1)).get("ticket") || ""),
    },
  }).then((response) => response.json());
  const send = (type, data = {}) =>
    parent.postMessage(
      { atlas: 1, type, id: "system", ...data },
      config.appOrigin,
    );
  // Website state has an HTTP(S)-origin prefix (or the retired host@ prefix).
  // Frontend preferences, chats, assignments and unrelated application DBs do
  // not belong to the browsing runtime, even on this same physical origin.
  const websiteName = (value) =>
    typeof value === "string" &&
    /^(?:https?:\/\/[^/@\s]+@|(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+)(?::[0-9]+)?@)/i.test(
      value,
    );
  const cookieName = (value) =>
    ["__runtimekit_controller", "__scramjet_controller"].includes(value);
  const migrationName = (value) =>
    value.startsWith("__atlas.logicalStorage.v1@http://") ||
    value.startsWith("__atlas.logicalStorage.v1@https://");
  window.addEventListener("message", async (event) => {
    if (
      event.source !== parent ||
      event.origin !== config.appOrigin ||
      event.data?.atlas !== 1 ||
      event.data.type !== "confirm-clear"
    )
      return;
    try {
      const databases = await indexedDB.databases();
      await Promise.all(
        databases
          .filter(
            (database) =>
              websiteName(database.name) || cookieName(database.name),
          )
          .map(
            (database) =>
              new Promise((resolve, reject) => {
                const request = indexedDB.deleteDatabase(database.name);
                request.onsuccess = resolve;
                request.onerror = () =>
                  reject(Error("Storage could not be cleared."));
                request.onblocked = () =>
                  reject(
                    Error(
                      "Close other Atlas browsing windows before clearing website data.",
                    ),
                  );
              }),
          ),
      );
      for (const store of [localStorage, sessionStorage]) {
        const names = [];
        for (let index = 0; index < store.length; index++) {
          const key = store.key(index);
          if (key && (websiteName(key) || migrationName(key))) names.push(key);
        }
        for (const key of names) store.removeItem(key);
      }
      for (const name of await caches.keys())
        if (websiteName(name)) await caches.delete(name);
      send("cleared");
    } catch (error) {
      send("clear-error", { message: error.message });
    }
  });
  send("clear-ready");
})();
