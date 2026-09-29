const { Resend } = require('resend');
const { findReport } = require('./fetchReports');
const { isAuthConfigured } = require('./basicAuth');
const { INK, MUTED, BORDER, escapeHtml, formatDateTime, button, wrapEmail } = require('./emailLayout');

// Resend's official Node SDK, not a hand-rolled SMTP transport. The API key
// (RESEND_API_KEY) and the verified `from` address (NOTIFY_EMAIL_FROM) are
// secrets and must stay server-side env vars - no overlay/UI can substitute
// for that. The *recipient* can instead come from the request body (the
// browser's notification-email overlay sends it as `to`), falling back to
// NOTIFY_EMAIL_TO if the request doesn't supply one - but only when
// APP_PASSWORD is set. See readConfig() below.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Everything actually emailed (subject, body, attachment) is re-derived
// server-side from a real NSM filing via findReport() - the request body's
// company/title/category/url are never used directly. Without this, anyone
// could POST arbitrary text and an arbitrary attachment URL and have it
// mailed out from this deployment's verified sending domain.
// isAllowedAttachmentUrl() is a second, independent check on top of that:
// findReport()'s url always comes from documentUrlOf() in lib/fetchReports.js,
// which is either the fixed NSM_ARTEFACT_BASE or a filing's own `html_link` -
// the latter isn't a documented/guaranteed field, so this only ever lets
// Resend fetch a URL on the NSM's own host, never wherever html_link might
// actually point.
const ALLOWED_ATTACHMENT_HOSTS = new Set(['data.fca.org.uk']);

function isAllowedAttachmentUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_ATTACHMENT_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function readConfig(requestedTo) {
  const { RESEND_API_KEY, NOTIFY_EMAIL_FROM, NOTIFY_EMAIL_TO } = process.env;
  const missing = ['RESEND_API_KEY', 'NOTIFY_EMAIL_FROM'].filter((key) => !process.env[key]);
  if (missing.length) {
    return { error: `Email notifications aren't configured. Missing env var(s): ${missing.join(', ')}` };
  }

  const requested = typeof requestedTo === 'string' && EMAIL_RE.test(requestedTo.trim()) ? requestedTo.trim() : null;

  // Without APP_PASSWORD, anyone who can reach the deployment can call
  // /api/notify, so a request-supplied recipient would let them send this
  // domain's mail to any address. A request's `to` is therefore only
  // honoured behind Basic Auth (any request reaching this point has then
  // already passed the login in server.js / middleware.js); an open
  // deployment only ever sends to the server-side NOTIFY_EMAIL_TO.
  if (!isAuthConfigured()) {
    if (!NOTIFY_EMAIL_TO) {
      return { status: 403, error: 'In-app recipients need APP_PASSWORD to be set (or set NOTIFY_EMAIL_TO to a fixed recipient).' };
    }
    if (requested && requested.toLowerCase() !== NOTIFY_EMAIL_TO.trim().toLowerCase()) {
      return { status: 403, error: 'Without APP_PASSWORD, this deployment only sends to its NOTIFY_EMAIL_TO address.' };
    }
    return { apiKey: RESEND_API_KEY, from: NOTIFY_EMAIL_FROM, to: NOTIFY_EMAIL_TO };
  }

  const to = requested || NOTIFY_EMAIL_TO;
  if (!to) {
    return { error: 'No recipient email address given (set NOTIFY_EMAIL_TO, or enter one in the app).' };
  }

  return { apiKey: RESEND_API_KEY, from: NOTIFY_EMAIL_FROM, to };
}

// Named after the URL's own last path segment when it looks like a real
// filename (has an extension); otherwise falls back to a generic name with
// a .pdf extension, since that's what NSM's own document links normally
// are (see lib/fetchReports.js's documentUrlOf()) - the handful of filings
// that link to something else (e.g. an HTML "Direct Upload" page) still get
// attached, just with a filename that doesn't match the actual content.
function filenameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last && /\.[a-z0-9]{2,5}$/i.test(last) ? last : 'report.pdf';
  } catch {
    return 'report.pdf';
  }
}

// Pulled out of sendNotification() so the markup is unit-testable without
// a network call. `attached` says whether the filing itself is attached,
// which changes what the call to action below needs to say.
function buildNotificationHtml(report, { attached = false } = {}) {
  const company = report.company || report.lei || 'Unknown company';
  const title = report.title || '(untitled)';
  const published = formatDateTime(report.publishedAt);

  const details = [
    report.category ? ['Type', report.category] : null,
    ['Published', published],
  ].filter(Boolean).map(([label, value]) => `<tr>
      <td width="90" style="width:90px;padding:6px 16px 6px 0;font-size:13px;color:${MUTED};white-space:nowrap;vertical-align:top;">${label}</td>
      <td style="padding:6px 0;font-size:13px;color:${INK};">${escapeHtml(value)}</td>
    </tr>`).join('');

  const cta = report.url
    ? `<div style="margin:20px 0 4px;">${button(report.url, 'View on NSM')}</div>`
    : '';
  const attachmentNote = attached
    ? `<p style="margin:16px 0 12px;font-size:12px;line-height:1.5;color:${MUTED};">The full document is attached to this email.</p>`
    : '<div style="height:12px;line-height:12px;font-size:1px;">&nbsp;</div>';

  const bodyHtml = `<p style="margin:0 0 4px;font-size:13px;font-weight:600;color:${MUTED};">${escapeHtml(company)}</p>
    <h2 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:${INK};">${escapeHtml(title)}</h2>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid ${BORDER};width:100%;">${details}</table>
    ${cta}
    ${attachmentNote}`;

  return wrapEmail({
    headline: `New filing from ${escapeHtml(company)}`,
    bodyHtml,
    preheader: `${title} - published ${published}`,
  });
}

async function sendNotification(payload) {
  const config = readConfig(payload && payload.to);
  if (config.error) return { ok: false, status: config.status, error: config.error };

  const report = await findReport({
    lei: payload && payload.lei,
    id: payload && payload.id,
    title: payload && payload.title,
    publishedAt: payload && payload.publishedAt,
  });
  if (!report) {
    return { ok: false, error: "Couldn't find a matching report to notify about - it may have aged out of the NSM search window." };
  }

  const company = report.company || report.lei || 'Unknown company';
  const title = report.title || '(untitled)';
  const subject = `RNS Update: ${company} - ${title}`;

  const resend = new Resend(config.apiKey);

  // Resend fetches the file itself server-side from `path` (rather than us
  // downloading and re-uploading it) - fine for the NSM's own document
  // links, which are public with no auth needed. Skipped when a report has
  // no url, or its url isn't on the NSM's own host (see
  // isAllowedAttachmentUrl above).
  const attachments = report.url && isAllowedAttachmentUrl(report.url)
    ? [{ path: report.url, filename: filenameFromUrl(report.url) }]
    : undefined;
  const html = buildNotificationHtml(report, { attached: Boolean(attachments) });

  try {
    const { error } = await resend.emails.send({
      from: config.from,
      to: config.to,
      subject,
      html,
      attachments,
    });
    if (error) {
      return { ok: false, error: `Failed to send email: ${error.message || JSON.stringify(error)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to send email: ${err.message || err}` };
  }
}

module.exports = { sendNotification, buildNotificationHtml };
