/** Trusted controller adapter. The peer port must be transferred BEFORE anybody
 * awaits enrollment ready. Website source policy is supplied by trusted source
 * acquisition; this adapter never derives authority from child descriptors. */
import { createNativeResourceOwner } from "./native-resource-owner.ts";
import type { NativeResourceIdentity } from "./native-resource-preparer.ts";
type NativeOwner = Awaited<ReturnType<typeof createNativeResourceOwner>>;
type OwnerOptions = Parameters<typeof createNativeResourceOwner>[0];
type Attachment = Parameters<NativeOwner["bind"]>[0];
type DocumentContext = Pick<
  Attachment,
  "documentId" | "documentURL" | "topLevelURL" | "contentPolicies" | "coep"
>;
type DocumentBindings = Pick<
  Attachment,
  "fetch" | "transform" | "forbiddenOrigins"
>;
type Common = {
  documentBindings?: (
    context: Readonly<DocumentContext>,
  ) => DocumentBindings | Promise<DocumentBindings>;
};
type Existing = {
  owner: NativeOwner;
  identity: () => NativeResourceIdentity;
  window?: Window & typeof globalThis;
};
const fail = (code: string) => Object.assign(new TypeError(code), { code });
const same = (a: NativeResourceIdentity, b: NativeResourceIdentity) =>
  a.nodeId === b.nodeId &&
  a.resourceOrigin === b.resourceOrigin &&
  a.leaseHash === b.leaseHash &&
  a.generation === b.generation;
const own = (value: object, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
export async function createNativeResourceProvider(
  options: Common & (OwnerOptions | Existing),
) {
  const identity = Object.freeze({ ...options.identity() }),
    origin = new URL(identity.resourceOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== identity.resourceOrigin ||
    !identity.nodeId ||
    !/^[a-f0-9]{64}$/.test(identity.leaseHash) ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 1
  )
    throw fail("native_provider_invalid_assignment");
  const owner =
    "owner" in options
      ? options.owner
      : await createNativeResourceOwner(options);
  const NativeChannel = options.window?.MessageChannel ?? MessageChannel;
  let live = true;
  type Record = {
    live: boolean;
    channel: MessageChannel;
    binding?: Awaited<ReturnType<NativeOwner["bind"]>>;
    dispose: () => void;
  };
  const records = new Map<string, Record>(),
    reserved = new Set<string>();
  function dispose() {
    if (!live) return;
    live = false;
    for (const entry of [...records.values()]) entry.dispose();
    records.clear();
    reserved.clear();
    try {
      owner.dispose();
    } catch {}
  }
  function check() {
    if (!live) throw fail("native_provider_disposed");
    if (!same(identity, options.identity())) {
      dispose();
      throw fail("native_provider_assignment_changed");
    }
    if (!owner.stats().live) {
      dispose();
      throw fail("native_provider_owner_unavailable");
    }
  }
  function context(input: DocumentContext) {
    if (
      !input ||
      typeof input !== "object" ||
      !/^[A-Za-z0-9_-]{16,96}$/.test(input.documentId) ||
      typeof input.documentURL !== "string" ||
      typeof input.topLevelURL !== "string" ||
      !Array.isArray(input.contentPolicies) ||
      input.contentPolicies.length > 32 ||
      input.contentPolicies.some(
        (v) => typeof v !== "string" || v.length > 65536,
      ) ||
      (input.coep !== undefined &&
        !["unsafe-none", "require-corp", "credentialless"].includes(input.coep))
    )
      throw fail("native_provider_invalid_document");
    const documentURL = new URL(input.documentURL),
      top = new URL(input.topLevelURL);
    if (
      [documentURL, top].some(
        (url) =>
          !/^https?:$/.test(url.protocol) || url.username || url.password,
      )
    )
      throw fail("native_provider_invalid_document");
    return Object.freeze({
      documentId: input.documentId,
      documentURL: documentURL.href,
      topLevelURL: top.href,
      contentPolicies: Object.freeze([
        ...input.contentPolicies,
      ]) as unknown as string[],
      ...(input.coep === undefined ? {} : { coep: input.coep }),
    });
  }
  function reserve(documentId: string) {
    check();
    if (
      reserved.has(documentId) ||
      records.has(documentId) ||
      reserved.size + records.size >= 32
    )
      throw fail("native_provider_document_exists");
    reserved.add(documentId);
  }
  async function attachReserved(
    input: Omit<Attachment, "port">,
    fixed: Readonly<DocumentContext>,
  ) {
    const channel = new NativeChannel(),
      entry = {} as Record;
    const close = () => {
      try {
        channel.port1.close();
      } catch {}
      try {
        channel.port2.close();
      } catch {}
    };
    const remove = () => {
      if (!entry.live) return;
      entry.live = false;
      records.delete(fixed.documentId);
      reserved.delete(fixed.documentId);
      try {
        entry.binding?.dispose();
      } catch {
        // One failed trusted cleanup must not retain any other document port.
      } finally {
        close();
      }
    };
    Object.assign(entry, { live: true, channel, dispose: remove });
    reserved.delete(fixed.documentId);
    records.set(fixed.documentId, entry);
    try {
      if (
        typeof input.fetch !== "function" ||
        (input.transform !== undefined &&
          typeof input.transform !== "function") ||
        (input.forbiddenOrigins !== undefined &&
          (!Array.isArray(input.forbiddenOrigins) ||
            input.forbiddenOrigins.some((v) => typeof v !== "string")))
      )
        throw fail("native_provider_invalid_bindings");
      const binding = await owner.bind({
        ...input,
        ...fixed,
        contentPolicies: [...fixed.contentPolicies],
        port: channel.port1,
      });
      if (!live || !entry.live) {
        try {
          binding.dispose();
        } catch {}
        throw fail("native_provider_disposed");
      }
      entry.binding = binding;
      check();
      void binding.ready.catch(() => remove());
      return {
        port: channel.port2,
        resourceOrigin: identity.resourceOrigin,
        get ready() {
          return binding.ready;
        },
        prepare: async (...args: Parameters<typeof binding.prepare>) => {
          check();
          if (!entry.live) throw fail("native_provider_document_disposed");
          const url = await binding.prepare(...args);
          check();
          if (!entry.live) throw fail("native_provider_document_disposed");
          const parsed = new URL(url);
          if (
            parsed.origin !== identity.resourceOrigin ||
            !/^\/native-resource\/v1\/resource\/[A-Za-z0-9_-]{43}$/.test(
              parsed.pathname,
            ) ||
            parsed.search ||
            parsed.hash
          )
            throw fail("native_provider_wrong_resource_node");
          return parsed.href;
        },
        dispose: remove,
      };
    } catch (error) {
      remove();
      throw error;
    }
  }
  return {
    resourceOrigin: identity.resourceOrigin,
    async attach(input: Omit<Attachment, "port">) {
      check();
      if (
        !input ||
        !own(input, [
          "documentId",
          "documentURL",
          "topLevelURL",
          "contentPolicies",
          "coep",
          "fetch",
          "transform",
          "forbiddenOrigins",
        ])
      )
        throw fail("native_provider_invalid_document");
      const fixed = context(input);
      reserve(fixed.documentId);
      try {
        return await attachReserved(input, fixed);
      } finally {
        reserved.delete(fixed.documentId);
      }
    },
    async bind(input: {
      documentId: string;
      website: string;
      topLevelURL?: string;
      contentPolicies: string[];
      coep?: Attachment["coep"];
    }) {
      check();
      if (
        !input ||
        !own(input, [
          "documentId",
          "website",
          "topLevelURL",
          "contentPolicies",
          "coep",
        ]) ||
        !options.documentBindings
      )
        throw fail("native_provider_trusted_bindings_required");
      const fixed = context({
        documentId: input.documentId,
        documentURL: input.website,
        topLevelURL: input.topLevelURL ?? input.website,
        contentPolicies: input.contentPolicies,
        coep: input.coep,
      });
      reserve(fixed.documentId);
      try {
        const supplied = await options.documentBindings(fixed);
        check();
        if (
          !supplied ||
          !own(supplied, ["fetch", "transform", "forbiddenOrigins"])
        )
          throw fail("native_provider_invalid_bindings");
        return await attachReserved(
          {
            ...supplied,
            ...fixed,
            contentPolicies: [...fixed.contentPolicies],
          },
          fixed,
        );
      } finally {
        reserved.delete(fixed.documentId);
      }
    },
    async renew() {
      check();
      await owner.renew();
      check();
    },
    dispose,
    stats() {
      if (live && !owner.stats().live) dispose();
      return {
        live,
        documents: records.size,
        reserved: reserved.size,
        resourceOrigin: identity.resourceOrigin,
      };
    },
  };
}
