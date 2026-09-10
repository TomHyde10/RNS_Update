const Anthropic = require('@anthropic-ai/sdk');
const { extractDocumentText } = require('./extractDocumentText');

// Summarises a report's document via the Claude API (official Anthropic
// SDK). Requires ANTHROPIC_API_KEY - the SDK also accepts ANTHROPIC_AUTH_TOKEN
// as an alternative credential source, but for a deployed server process
// (Render/Vercel) an API key is the practical option, not an interactive
// `ant auth login` profile. Model defaults to claude-opus-5; override with
// ANTHROPIC_MODEL if you want a cheaper/faster model for this task.
const DEFAULT_MODEL = 'claude-opus-5';
const MAX_OUTPUT_TOKENS = 1024; // a 3-6 bullet summary needs only a few hundred tokens

function buildPrompt({ company, title, category, text, truncated }) {
  return [
    'You are a financial analyst assistant. Summarise the following UK-listed ' +
      'investment trust regulatory filing in 3-6 concise bullet points.',
    'Focus on key financial figures (NAV, returns, dividends), material changes, ' +
      'and any stated outlook. Be factual - do not speculate beyond what the text says.',
    '',
    `Company: ${company || 'Unknown'}`,
    `Filing type: ${category || title || 'Unknown'}`,
    '',
    `Document text${truncated ? ' (truncated)' : ''}:`,
    text,
  ].join('\n');
}

async function summariseReport(report) {
  if (!report || !report.url) {
    return { ok: false, error: 'This report has no linked document to summarise.' };
  }

  const extracted = await extractDocumentText(report.url);
  if (extracted.error) return { ok: false, error: extracted.error };

  const prompt = buildPrompt({
    company: report.company,
    title: report.title,
    category: report.category,
    text: extracted.text,
    truncated: extracted.truncated,
  });

  // The SDK doesn't throw a typed error for missing credentials until the
  // request itself is made (just a plain Error, not AnthropicError/APIError -
  // confirmed by testing), so check explicitly here for a clean, specific
  // message rather than parsing that string.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return { ok: false, error: "Summarisation isn't configured. Missing env var: ANTHROPIC_API_KEY" };
  }

  const client = new Anthropic();
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    });

    if (response.stop_reason === 'refusal') {
      const category = response.stop_details && response.stop_details.category;
      return { ok: false, error: `Claude declined to summarise this document${category ? ` (${category})` : ''}.` };
    }

    const textBlock = response.content.find((block) => block.type === 'text');
    if (!textBlock) {
      return { ok: false, error: 'Claude API returned no text content.' };
    }

    return { ok: true, summary: textBlock.text.trim(), truncated: extracted.truncated };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, error: 'Claude API authentication failed - check ANTHROPIC_API_KEY.' };
    }
    if (err instanceof Anthropic.RateLimitError) {
      return { ok: false, error: 'Claude API rate limited - try again shortly.' };
    }
    if (err instanceof Anthropic.APIError) {
      return { ok: false, error: `Claude API error ${err.status}: ${err.message}` };
    }
    return { ok: false, error: `Failed to reach the Claude API: ${err.message || err}` };
  }
}

module.exports = { summariseReport };
