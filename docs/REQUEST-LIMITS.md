# IP request controls

Open the owner panel → **Request limits**. Changes apply immediately when saved and persist in the SQLite settings store.

- Turn **Enable IP request limits** off to remove Atlas's per-IP API throttling and per-IP AI concurrency cap.
- Adjust each rule's request count and time window. A count of **0** disables that individual rule; time windows are in seconds. The overall API cap still applies unless disabled or the IP is whitelisted. Node heartbeats have their own cap, without the overall API cap.
- Add individual IPv4/IPv6 addresses or CIDR networks to **IP whitelist**, one per line. Commas and whitespace also work. **Add current IP** uses the address the server sees. IPv4-mapped IPv6 addresses match the corresponding IPv4 address. Networks are normalized and duplicates removed.
- Whitelisted IPs skip all the IP rules and per-IP AI concurrency. This is not an administrator login or authentication exemption.
- Saving a changed policy clears only IP counters, not per-ticket reply budgets or global AI/provider budgets. A verified owner can always use the request-limit settings and session-state endpoints to repair an overly low API cap; session verification, Origin and CSRF checks still apply.

Default rules preserve prior behavior: API 600/minute, suggestions 120/minute, owner sign-in/setup 8/15 minutes, tickets 5/hour, browsing session creation 60/minute, node heartbeats 120/minute, AI messages 20/hour and two concurrent AI replies per IP.

## CloudFront and real visitor IPs

Follow [NODES.md](NODES.md) for the trusted CloudFront viewer-header/Caddy configuration. Atlas matches Fastify's `req.ip` after the configured `TRUST_PROXY` chain, not an arbitrary caller-supplied header. Without that setup, you might see the reverse proxy address and accidentally exempt every visitor behind it. Never set a universal trust proxy solely to make an IP header work.

## Environment defaults

For an installation with no saved request-limit settings:

```dotenv
IP_RATE_LIMIT_ENABLED=true
IP_RATE_LIMIT_WHITELIST=192.0.2.10,2001:db8::/48
IP_RATE_LIMIT_AI_CONCURRENT=2
IP_RATE_LIMIT_RULES={"api":{"max":600,"windowSeconds":60},"ticket":{"max":0}}
```

Omit the example documentation IPs for a real deployment. Saved owner settings take precedence over environment defaults. An operator recovering a locked-out owner can stop the app, back up its data, and update/delete the `ipRequestLimits` entry in the SQLite `settings` table before restarting. Deleting that entry restores environment defaults.

These controls target client-IP Atlas API throttles on the main frontend/backend. They do not alter destination/private-network filtering, node authentication, per-ticket reply caps, AI provider quotas/global budgets, browsing session socket limits or whole-server capacity. Normal production browsing nodes use signed sessions, not the anonymous demo runtime's development-only IP socket cap.
