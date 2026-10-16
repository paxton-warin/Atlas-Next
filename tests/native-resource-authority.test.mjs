import test from "node:test";
import assert from "node:assert/strict";
import { createNativeResourceAuthority } from "../server/native-resource-authority.mjs";
import { signTicket } from "../server/node-ticket.mjs";
const frontend = "https://frontend.example",
  resource = "https://node.example",
  secret = "fixture-secret-".repeat(4),
  hash = "b".repeat(64);
test("native upload authority separates role/purpose, exact selected HTTPS origin, generation and live lease", () => {
  let live = true;
  const ticket = {
    role: "frontend-resource-owner-v1",
    purpose: "native-resource-owner",
    node: "selected",
    lease: hash,
    generation: 2,
    origin: frontend,
    runtimeOrigin: frontend,
    resourceOrigin: resource,
    expires: Date.now() + 60000,
  };
  const authority = createNativeResourceAuthority({
    nodeId: () => "selected",
    secret: () => secret,
    originFor: () => resource,
    liveLease: (v) => live && v.leaseHash === hash && v.generation === 2,
  });
  const request = (patch = {}, origin = frontend) => ({
    headers: {
      origin,
      authorization: "Bearer " + signTicket({ ...ticket, ...patch }, secret),
    },
  });
  const identity = authority.authorizeOwner(request());
  assert.deepEqual(identity, {
    nodeId: "selected",
    frontendOrigin: frontend,
    resourceOrigin: resource,
    leaseHash: hash,
    generation: 2,
    expiresAt: ticket.expires,
  });
  for (const patch of [
    { role: "frontend-controller-v2" },
    { purpose: "relay" },
    { resourceOrigin: "https://other.example" },
    { relayOrigin: resource },
    { generation: 1 },
    { node: "other" },
    { expires: Date.now() - 1 },
  ])
    assert.equal(authority.authorizeOwner(request(patch)), null);
  for (const origin of [
    "null",
    "https://peer.example",
    "http://frontend.example",
  ])
    assert.equal(authority.authorizeOwner(request({}, origin)), null);
  live = false;
  assert.equal(authority.validateOwner(identity), false);
  assert.equal(authority.authorizeOwner(request()), null);
});
