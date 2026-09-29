// Shared HTML shell and building blocks for every email this app sends -
// the per-report notification (lib/sendNotification.js) and the digest
// (lib/sendDigest.js) - so both look like the same product.
//
// Email HTML is its own dialect: inline styles only (Gmail and others strip
// <style> blocks), and layout done with tables rather than divs, because
// classic Outlook (Word's rendering engine) ignores max-width, and padding,
// margins and backgrounds on divs - it would otherwise stretch the email
// edge-to-edge with the header text flush against the window. Widths
// go in `width` attributes as well as CSS for the same reason. Colours are
// always spelled out explicitly, since clients' dark-mode remapping of
// unstyled text is unpredictable.

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = '#0f172a';
const MUTED = '#64748b';
const SUBTLE = '#94a3b8';
const BORDER = '#e2e8f0';
const PAGE_BG = '#f1f5f9';
const ACCENT = '#2563eb';
const WIDTH = 600;

// RNS publishing is UK-market, so times are shown in UK time regardless of
// which timezone the server happens to run in (containers are usually UTC,
// which would read an hour out for half the year).
const TIME_ZONE = 'Europe/London';

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function toDate(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

// "28 Sept 2026, 09:03" - for headers and one-off timestamps.
function formatDateTime(iso) {
  const d = toDate(iso);
  if (!d) return 'Unknown date';
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE,
  });
}

// "28 Sept, 10:22" - for list rows, where the year is noise.
function formatShortDateTime(iso) {
  const d = toDate(iso);
  if (!d) return 'Unknown date';
  return d.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE,
  });
}

// A table-based button - an <a> styled as a block alone collapses to a
// plain link in Outlook, but a coloured cell around it survives everywhere.
function button(href, label) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
    <tr>
      <td bgcolor="${ACCENT}" style="background:${ACCENT};border-radius:6px;">
        <a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;font-family:${FONT};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

// Optional - without it the footer link is simply omitted. Read per call
// (not at module load) so it's never stale relative to the environment.
// Trailing slashes stripped so `${appUrl}/#notifications` never has `//`.
function appUrl() {
  return (process.env.APP_URL || '').trim().replace(/\/+$/, '');
}

// `preheader` is the grey preview snippet most inboxes show next to the
// subject - hidden in the body itself. Without it, clients fall back to
// the first visible text, which is just "RNS Update" again.
function wrapEmail({ headline, bodyHtml, preheader }) {
  const url = appUrl();
  const footerLink = url
    ? `<a href="${escapeHtml(url)}/#notifications" style="color:${MUTED};text-decoration:underline;">Manage notification preferences</a>`
    : '';
  const hiddenPreheader = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${PAGE_BG};">${escapeHtml(preheader)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>RNS Update</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};">
${hiddenPreheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE_BG}" style="background:${PAGE_BG};">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="${WIDTH}" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${WIDTH}px;border-collapse:separate;font-family:${FONT};">
        <tr>
          <td bgcolor="${INK}" style="background:${INK};border-radius:8px 8px 0 0;padding:20px 28px;">
            <p style="margin:0;font-family:${FONT};font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${SUBTLE};">RNS Update</p>
            <p style="margin:6px 0 0;font-family:${FONT};font-size:17px;font-weight:600;line-height:1.35;color:#ffffff;">${headline}</p>
          </td>
        </tr>
        <tr>
          <td bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${BORDER};border-top:none;border-radius:0 0 8px 8px;padding:24px 28px 12px;font-family:${FONT};color:${INK};">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:16px 12px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">
            Filings sourced from the FCA National Storage Mechanism.${footerLink ? `<br>${footerLink}` : ''}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

module.exports = {
  FONT, INK, MUTED, SUBTLE, BORDER, ACCENT,
  escapeHtml, formatDateTime, formatShortDateTime, button, wrapEmail,
};
