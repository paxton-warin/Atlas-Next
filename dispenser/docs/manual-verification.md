# Directory-based manual verification

The existing email rules remain the first eligibility filter. Email ownership
must still be verified through the existing sign-in flow. Check-Mail runs only
for eligible new accounts that are not on its separate checker whitelist; both
code delivery and valid-code submission check the current email rules first.
Returning accounts do not consume provider requests.

## Administrator controls

**Email Rules → Known emails** contains exact-domain policies and the school
directories within each domain. Add a domain, upload a named school's plain-text
email directory, then enable that domain. Additional schools and domains use the
same controls. Domains default to disabled in the database; the deployment
imports the supplied directory privately as **McLean High School**, then enables
`fcpsschools.net` atomically.

Directories accept email entries separated by whitespace, commas, or semicolons;
addresses are trimmed, lowercased, and deduplicated. All entries must belong to
the selected exact domain. Uploads are limited to 1.9 MB and 50,000 entries.
Invalid uploads leave the previous directory intact. Directory addition/replacement, school renaming/enabling, and domain
activation/deletion are administrator-only. Remove individual addresses by
uploading a corrected replacement file. Student addresses are held in the
private database, never bundled with the frontend or committed to source.

**Manual verification** lists requests, with search/status filters and review
controls. A user's detail also displays their request. Approve or deny the
current revision; a stale review returns a conflict rather than approving edited
content. An explicit denial overrides later directory membership while the
policy is enabled. Disabling/removing a policy is an explicit administrator
choice to stop that domain's directory gate; its requests remain retained.

## User behavior

An eligible, email-verified, non-administrator account in an enabled domain must
be in an enabled school directory or have an approved request to use dispenser
links. This applies to existing sessions as well as new accounts. Missing,
pending, and denied requests are blocked from assignment/history, allocation,
and reporting APIs, not just hidden by the interface. Administrators are exempt.

The restricted screen collects a name, school name, and additional written
information. One database-enforced request exists per user. Submission, edits,
reloads, and subsequent sign-ins return to that request. Logout remains available.
Pending requests remain editable. Denied requests remain denied after editing
until an administrator changes the decision. Editing approved content returns it
to pending review. Visible restricted pages refresh status every 15 seconds.

This gate protects the dispenser. It does not revoke shared Atlas URLs that were
already copied or add per-person authentication to the separate Atlas browser.

## Release and rollback

Migration `0008_manual_verification.sql` adds four tables without rewriting
existing user, session, assignment, quota, email-rule, or Check-Mail data. Preserve
an online database backup, configuration, and previous application image before
rollout. Rehearse the new and previous images against an isolated restored copy.
Application-image rollback leaves the additive tables and submitted data intact;
it does not restore an old database over newer sign-ins or link history.
