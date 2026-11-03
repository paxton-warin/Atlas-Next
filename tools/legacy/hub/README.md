# Historical link-list replacement helper

This is the former standalone Hub console utility, retained for source history
and its synthetic unit tests. It **deletes and recreates link records** through
administrator APIs; that process can remove assignments, history and usage data.
It is **not** an assignment-preserving account/endpoint migration procedure and
is not invoked by any normal Atlas build, test, startup or deployment command.

The executable helper's bytes are unchanged. Its extension is `.cjs` solely to
preserve its original CommonJS test loading after moving under the parent ESM
package; browser console JavaScript is the same. The adjacent tests operate only
on synthetic in-memory API fixtures:

```sh
node --test tools/legacy/hub/replace-links.browser.test.mjs
```

No live link replacement was run during the repository cleanup.
