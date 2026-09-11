const nodemailer = require('nodemailer');

// Standard, documented SMTP - unlike the NSM integration, nothing here is
// reverse-engineered. The *sending* account (SMTP_HOST/PORT/USER/PASS,
// NOTIFY_EMAIL_FROM) is a secret and must stay server-side env vars - no
// overlay/UI can substitute for that. The *recipient* can instead come from
// the request body (the browser's notification-email overlay sends it as
// `to`), falling back to NOTIFY_EMAIL_TO if the request doesn't supply one,
// so a deployment can either fix the recipient via env var or let each
// visitor set their own.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function readConfig(requestedTo) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL_FROM, NOTIFY_EMAIL_TO } = process.env;
  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'NOTIFY_EMAIL_FROM'].filter(
    (key) => !process.env[key]
  );
  if (missing.length) {
    return { error: `Email notifications aren't configured. Missing env var(s): ${missing.join(', ')}` };
  }

  const to = (typeof requestedTo === 'string' && EMAIL_RE.test(requestedTo.trim()) && requestedTo.trim()) || NOTIFY_EMAIL_TO;
  if (!to) {
    return { error: 'No recipient email address given (set NOTIFY_EMAIL_TO, or enter one in the app).' };
  }

  return {
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    user: SMTP_USER,
    pass: SMTP_PASS,
    from: NOTIFY_EMAIL_FROM,
    to,
  };
}

function formatDate(iso) {
  if (!iso) return 'Unknown date';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleString('en-GB');
}

async function sendNotification(report) {
  const config = readConfig(report && report.to);
  if (config.error) return { ok: false, error: config.error };

  const company = report.company || report.lei || 'Unknown company';
  const title = report.title || '(untitled)';
  const subject = `RNS Update: ${company} - ${title}`;
  const lines = [
    `Company: ${company}`,
    `Report: ${title}`,
    report.category ? `Type: ${report.category}` : null,
    `Published: ${formatDate(report.publishedAt)}`,
    report.url ? `Link: ${report.url}` : null,
  ].filter(Boolean);

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.pass },
  });

  try {
    await transporter.sendMail({
      from: config.from,
      to: config.to,
      subject,
      text: lines.join('\n'),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Failed to send email: ${err.message || err}` };
  }
}

module.exports = { sendNotification };
