const nodemailer = require('nodemailer');

// Standard, documented SMTP - unlike the NSM integration, nothing here is
// reverse-engineered. Configured entirely via env vars so no credentials or
// recipient address are hardcoded/committed. Sending is genuinely untested
// from this sandbox (no network access to any SMTP host), so treat a first
// real send as the actual verification step.
function readConfig() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL_FROM, NOTIFY_EMAIL_TO } = process.env;
  const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'NOTIFY_EMAIL_FROM', 'NOTIFY_EMAIL_TO'].filter(
    (key) => !process.env[key]
  );
  if (missing.length) {
    return { error: `Email notifications aren't configured. Missing env var(s): ${missing.join(', ')}` };
  }
  return {
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    user: SMTP_USER,
    pass: SMTP_PASS,
    from: NOTIFY_EMAIL_FROM,
    to: NOTIFY_EMAIL_TO,
  };
}

function formatDate(iso) {
  if (!iso) return 'Unknown date';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Unknown date' : d.toLocaleString('en-GB');
}

async function sendNotification(report) {
  const config = readConfig();
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
