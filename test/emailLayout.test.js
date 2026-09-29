const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { wrapEmail, formatDateTime } = require('../lib/emailLayout');
const { buildNotificationHtml } = require('../lib/sendNotification');

describe('wrapEmail', () => {
  it('uses a fixed-width table shell (Outlook ignores max-width on divs)', () => {
    const html = wrapEmail({ headline: 'H', bodyHtml: '<p>B</p>' });
    assert.match(html, /<table[^>]*width="600"/);
  });

  it('includes an escaped, hidden preheader when given', () => {
    const html = wrapEmail({ headline: 'H', bodyHtml: '', preheader: '<b>x</b>' });
    assert.match(html, /display:none[^>]*>&lt;b&gt;x&lt;\/b&gt;</);
  });
});

describe('formatDateTime', () => {
  it('renders in UK time without seconds, regardless of server timezone', () => {
    // 09:03:35 UTC in September is 10:03 BST.
    assert.match(formatDateTime('2026-09-28T09:03:35Z'), /^28 Sept? 2026, 10:03$/);
  });

  it('handles missing and invalid dates', () => {
    assert.equal(formatDateTime(null), 'Unknown date');
    assert.equal(formatDateTime('nope'), 'Unknown date');
  });
});

describe('buildNotificationHtml', () => {
  const report = {
    company: 'Brunner & Co', title: 'Half-year <Report>', category: 'Half-year Financial Report',
    publishedAt: '2026-09-28T09:00:00Z', url: 'https://data.fca.org.uk/x.pdf',
  };

  it('shows company, escaped title and a button link instead of a raw URL', () => {
    const html = buildNotificationHtml(report);
    assert.match(html, /Brunner &amp; Co/);
    assert.match(html, /Half-year &lt;Report&gt;/);
    assert.match(html, /<a href="https:\/\/data\.fca\.org\.uk\/x\.pdf"[^>]*>View on NSM<\/a>/);
    assert.ok(!html.includes('>https://data.fca.org.uk'), 'the URL itself should not be printed as link text');
  });

  it('only mentions the attachment when one is actually attached', () => {
    assert.match(buildNotificationHtml(report, { attached: true }), /attached to this email/);
    assert.ok(!buildNotificationHtml(report).includes('attached to this email'));
  });

  it('omits the button when there is no url', () => {
    assert.ok(!buildNotificationHtml({ ...report, url: null }).includes('View on NSM'));
  });
});
