# Google Drive setup

1. Create or select a project in Google Cloud Console.
2. Enable **Google Drive API**.
3. Configure the OAuth consent screen. For a personal Gmail account, choose an external app and add the verification account as a test user while the app remains in testing.
4. Create an **OAuth client ID** of type **Web application**.
5. Add exactly `https://links.example.com/api/admin/google/callback` as an authorized redirect URI, replacing the hostname with `APP_URL`.
6. Put the client ID, client secret, and identical redirect URI in `.env`, then run `docker compose up -d --build`.
7. Complete first-run setup, open **Administration → Verification**, and select **Connect**.
8. Sign into the server-controlled Google account, grant access, and run **Test connection**.

The app requests `drive.file` and `userinfo.email`. `drive.file` limits Atlas Link Dispenser to files it creates. The test creates and removes one harmless text file. Normal automated tests use a fake Drive provider and never contact Google.

Google may show an unverified-app warning while an external consent screen is in testing. A testing grant that includes Drive access expires after seven days; using the refresh token does not extend that deadline. For unattended backend operation, change the consent screen's publishing status to **In production**, then reconnect the account once. The server refreshes access tokens before Drive operations and persists refreshed credentials.

If an expired grant prevents the administrator from signing in, open `/adminrecovery` directly and enter `BOOTSTRAP_ADMIN_EMAIL` plus `BOOTSTRAP_TOKEN`. The recovery page is intentionally not linked from the sign-in screen. Reconnect Google in **Administration → Verification** after recovering the session.
