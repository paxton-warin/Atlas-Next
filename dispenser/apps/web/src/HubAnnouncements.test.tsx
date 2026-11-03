import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminAnnouncements, AnnouncementContent, AnnouncementDetail, announcementDraftValid, announcementReadPermitted } from "./HubAnnouncements";
import { HubNotificationBell, NotificationActivity, isAnnouncementNotification, supportStatusLabel, supportAuthorLabel, notificationSeenCursor, type HubNotification } from "./HubSupport";
import { adminDestination, adminGroup, adminPanelURL } from "./Admin";
const announcement: HubNotification = { id: "7", kind: "announcement", announcement_id: "announcement-1", ticket_id: null, subject: "News <script>", read_at: null };
describe("global announcements and support identity", () => {
  it("keeps announcements in the Support navigation group with stable deep links", () => {
    expect(adminDestination("?admin=announcements")).toBe("announcements");
    expect(adminGroup("announcements")).toBe("support");
    expect(adminPanelURL("announcements")).toBe("/?admin=announcements");
  });
  it("bounds plaintext draft lengths without discarding whitespace in the actual content", () => {
    expect(announcementDraftValid(" News ", " Line\nTwo ")).toBe(true);
    for (const [title, body] of [[" ", "x"], ["x", "\n"], ["x".repeat(121), "x"], ["x", "x".repeat(5001)]]) expect(announcementDraftValid(title, body)).toBe(false);
    expect(announcementDraftValid("x".repeat(120), "x".repeat(5000))).toBe(true);
  });
  it("renders announcement text as text with basic bold, never raw HTML", () => {
    const html = renderToStaticMarkup(<AnnouncementContent title="<img src=x>" body={'<script>alert(1)</script>\n**plain text**'} />);
    expect(html).toContain("&lt;img src=x&gt;"); expect(html).toContain("&lt;script&gt;"); expect(html).toContain("<strong>plain text</strong>"); expect(html).not.toContain("<script>");
  });
  it("mixes support and announcement feed rows without inventing ticket IDs or message bodies", () => {
    const html = renderToStaticMarkup(<NotificationActivity notifications={[announcement, { id: "6", ticket_id: "ticket-1", subject: "Help", read_at: "now" }]} onOpen={() => {}} onAnnouncement={() => {}} />);
    expect(html).toContain("Atlas announcement"); expect(html).toContain("Support replied"); expect(html).toContain("News &lt;script&gt;"); expect(html.match(/aria-label="Unread"/g)).toHaveLength(1);
    expect(isAnnouncementNotification(announcement)).toBe(true);
    expect(isAnnouncementNotification({ ...announcement, announcement_id: null })).toBe(false);
  });
  it("does not acknowledge from bell render, hidden content, loading or background state", () => {
    expect(renderToStaticMarkup(<HubNotificationBell onOpen={() => {}} />)).toContain('aria-label="Notifications"');
    expect(renderToStaticMarkup(<AnnouncementDetail id="" onClose={() => {}} />)).toContain("Loading announcement");
    expect(announcementReadPermitted(false,true,true)).toBe(false); expect(announcementReadPermitted(true,false,true)).toBe(false); expect(announcementReadPermitted(true,true,false)).toBe(false);
    expect(announcementReadPermitted(true,true,true)).toBe(true);
  });
  it("preserves the user enum and says Awaiting user only to admins", () => {
    expect(supportStatusLabel("awaiting_you")).toBe("Awaiting you"); expect(supportStatusLabel("awaiting_you", true)).toBe("Awaiting user"); expect(supportStatusLabel("closed", true)).toBe("Closed");
  });
  it("uses email only for admin user-authored posts, with honest legacy fallback", () => {
    expect(supportAuthorLabel("user", true, "member@example.test", "requester@example.test")).toBe("member@example.test");
    expect(supportAuthorLabel("user", true, null, "requester@example.test")).toBe("requester@example.test");
    expect(supportAuthorLabel("user", true)).toBe("User");
    expect(supportAuthorLabel("user", false, "member@example.test")).toBe("You");
    expect(supportAuthorLabel("admin", true, "admin@example.test")).toBe("Atlas support");
  });
  it("keeps the seen cursor monotonic across unread-first reorder, withdrawal and empty feeds", () => {
    expect(notificationSeenCursor(null, [{ id: "4" }, { id: "100" }, { id: "8" }])).toBe("100");
    expect(notificationSeenCursor("100", [{ id: "7" }, { id: "90" }])).toBe("100");
    expect(notificationSeenCursor("100", [])).toBe("100");
    expect(notificationSeenCursor(null, [])).toBe("0");
    expect(notificationSeenCursor("9007199254740993", [{ id: "9007199254740992" }, { id: "9007199254740994" }])).toBe("9007199254740994");
  });
  it("requires review before publishing and includes separate withdrawal confirmation", () => {
    const html = renderToStaticMarkup(<AdminAnnouncements active={false} />);
    expect(html).toContain("Review and publish"); expect(html).toContain("Publish to all users?"); expect(html).toContain("Withdraw announcement?"); expect(html).toContain('maxLength="120"'); expect(html).toContain('maxLength="5000"');
  });
});
