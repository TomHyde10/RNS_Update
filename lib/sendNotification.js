const { Resend } = require('resend');

// Resend's official Node SDK, not a hand-rolled SMTP transport. The API key
// (RESEND_API_KEY) and the verified `from` address (NOTIFY_EMAIL_FROM) are
// secrets and must stay server-side env vars - no overlay/UI can substitute
// for that. The *recipient* can instead come from the request body (the
// browser's notification-email overlay sends it as `to`), falling back to
// NOTIFY_EMAIL_TO if the request doesn't supply one, so a deployment can
// either fix the recipient via env var or let each visitor set their own.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

async function sendNotification(report) {
  const config = readConfig(report && report.to);
  if (config.error) return { ok: false, error: config.error };

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

  try {
    const { error } = await resend.emails.send({
      from: config.from,
      to: config.to,
      subject,
      html,
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
