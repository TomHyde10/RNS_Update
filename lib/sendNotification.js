const { Resend } = require('resend');
const { findReport } = require('./fetchReports');

// Resend's official Node SDK, not a hand-rolled SMTP transport. The API key
// (RESEND_API_KEY) and the verified `from` address (NOTIFY_EMAIL_FROM) are
// secrets and must stay server-side env vars - no overlay/UI can substitute
// for that. The *recipient* can instead come from the request body (the
// browser's notification-email overlay sends it as `to`), falling back to
// NOTIFY_EMAIL_TO if the request doesn't supply one, so a deployment can
// either fix the recipient via env var or let each visitor set their own.
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

  const to = (typeof requestedTo === 'string' && EMAIL_RE.test(requestedTo.trim()) && requestedTo.trim()) || NOTIFY_EMAIL_TO;
  if (!to) {
    return { error: 'No recipient email address given (set NOTIFY_EMAIL_TO, or enter one in the app).' };
  }

  return { apiKey: RESEND_API_KEY, from: NOTIFY_EMAIL_FROM, to };
}

function formatDate(iso) {
  if (!iso) return 'Unknown date';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleString('en-GB');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
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

async function sendNotification(payload) {
  const config = readConfig(payload && payload.to);
  if (config.error) return { ok: false, error: config.error };

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

  const rows = [
    ['Company', escapeHtml(company)],
    ['Report', escapeHtml(title)],
    report.category ? ['Type', escapeHtml(report.category)] : null,
    ['Published', escapeHtml(formatDate(report.publishedAt))],
    report.url ? ['Link', `<a href="${escapeHtml(report.url)}">${escapeHtml(report.url)}</a>`] : null,
  ].filter(Boolean);
  const html = `<p>${rows.map(([label, value]) => `<strong>${label}:</strong> ${value}`).join('<br>')}</p>`;

  const resend = new Resend(config.apiKey);

  // Resend fetches the file itself server-side from `path` (rather than us
  // downloading and re-uploading it) - fine for the NSM's own document
  // links, which are public with no auth needed. Skipped when a report has
  // no url, or its url isn't on the NSM's own host (see
  // isAllowedAttachmentUrl above).
  const attachments = report.url && isAllowedAttachmentUrl(report.url)
    ? [{ path: report.url, filename: filenameFromUrl(report.url) }]
    : undefined;

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

module.exports = { sendNotification };
