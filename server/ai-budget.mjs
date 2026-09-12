// Provider budgets are shared by all visitors, persisted, and independent of IP exemptions.
export function createAiBudget(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_usage (provider TEXT, period TEXT, reset INTEGER, requests INTEGER, tokens INTEGER, PRIMARY KEY(provider,period));
    CREATE TABLE IF NOT EXISTS ai_cooldowns (provider TEXT PRIMARY KEY, until INTEGER, reason TEXT);`);
  const row = db.prepare(
    "SELECT * FROM ai_usage WHERE provider=? AND period=?",
  );
  const read = (id, period, now = Date.now()) => {
    const r = row.get(id, period);
    return r && r.reset > now
      ? r
      : {
          reset:
            period === "day"
              ? (Math.floor(now / 86400000) + 1) * 86400000
              : now + 60000,
          requests: 0,
          tokens: 0,
        };
  };
  const cooldown = (id) => {
    const r = db.prepare("SELECT * FROM ai_cooldowns WHERE provider=?").get(id);
    return r?.until > Date.now() ? r : null;
  };
  return {
    status(id) {
      return {
        minute: read(id, "minute"),
        day: read(id, "day"),
        cooldown: cooldown(id),
      };
    },
    cool(id, seconds, reason) {
      db.prepare(
        "INSERT INTO ai_cooldowns VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET until=excluded.until,reason=excluded.reason",
      ).run(
        id,
        Date.now() + Math.min(86400, Math.max(1, seconds)) * 1000,
        reason,
      );
    },
    reserve(provider, tokens) {
      if (cooldown(provider.id)) return null;
      let minute, day;
      db.exec("BEGIN IMMEDIATE");
      try {
        const now = Date.now(),
          l = provider.limits;
        minute = read(provider.id, "minute", now);
        day = read(provider.id, "day", now);
        if (
          minute.requests + 1 > l.rpm ||
          day.requests + 1 > l.rpd ||
          minute.tokens + tokens > l.tpm ||
          day.tokens + tokens > l.tpd
        ) {
          db.exec("ROLLBACK");
          return null;
        }
        for (const [period, value] of [
          ["minute", minute],
          ["day", day],
        ])
          db.prepare(
            "INSERT INTO ai_usage VALUES (?,?,?,?,?) ON CONFLICT(provider,period) DO UPDATE SET reset=excluded.reset,requests=excluded.requests,tokens=excluded.tokens",
          ).run(
            provider.id,
            period,
            value.reset,
            value.requests + 1,
            value.tokens + tokens,
          );
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      let settled = false;
      return (actual) => {
        if (
          settled ||
          !Number.isSafeInteger(actual) ||
          actual < 0 ||
          actual > 10000000
        )
          return;
        settled = true;
        for (const [period, value] of [
          ["minute", minute],
          ["day", day],
        ])
          db.prepare(
            "UPDATE ai_usage SET tokens=MAX(0,tokens+?) WHERE provider=? AND period=? AND reset=?",
          ).run(actual - tokens, provider.id, period, value.reset);
      };
    },
  };
}
