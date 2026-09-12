import { resolve } from "node:path";
import { openStore, token, digest } from "../server/store.mjs";
const s = openStore(resolve(process.env.DATA_DIR || "data"));
if (s.get("admin")) {
  console.log(
    "Administrator is already enrolled. Use a recovery code to sign in.",
  );
  s.db.close();
  process.exit(1);
}
const value = token();
s.set("bootstrap", { hash: digest(value), expires: Date.now() + 900000 });
s.db.close();
console.log(
  "One-time setup token (expires in 15 minutes):\n" +
    value +
    "\nOpen " +
    (process.env.APP_ORIGIN || "http://localhost:4180") +
    (process.env.ADMIN_PATH || "/_control/atlas-owner"),
);
