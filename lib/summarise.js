const { extractDocumentText } = require('./extractDocumentText');

// Talks to a self-hosted, open-weight LLM over its OpenAI-compatible
// /chat/completions endpoint - deliberately not a hosted third-party API
// (no Anthropic/OpenAI/etc. key anywhere here). This is the same shape
// Ollama (via its /v1 compatibility layer), llama.cpp's server, vLLM,
// LocalAI, and text-generation-webui's openai extension all speak, so
// pointing LLM_BASE_URL at any of those should work without code changes.
// Genuinely untested from this sandbox: no network access to any FCA
// artefact host to fetch a real filing, and no LLM server to call either -
// the first real click after configuring this is the actual integration
// test, same as the SMTP email feature was before it was pulled out.
function readConfig() {
  const { LLM_BASE_URL, LLM_MODEL, LLM_API_KEY } = process.env;
  const missing = ['LLM_BASE_URL', 'LLM_MODEL'].filter((key) => !process.env[key]);
  if (missing.length) {
    return { error: `Summarisation isn't configured. Missing env var(s): ${missing.join(', ')}` };
  }
  return { baseUrl: LLM_BASE_URL.replace(/\/+$/, ''), model: LLM_MODEL, apiKey: LLM_API_KEY };
}

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
  const config = readConfig();
  if (config.error) return { ok: false, error: config.error };

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

  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        stream: false,
      }),
    });
  } catch (err) {
    return { ok: false, error: `Failed to reach the LLM server at ${config.baseUrl}: ${err.message || err}` };
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    return { ok: false, error: `LLM server returned ${response.status}`, details: details.slice(0, 1000) };
  }

  const data = await response.json();
  const summary = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!summary) {
    return { ok: false, error: 'LLM server returned an unexpected response shape (no choices[0].message.content).' };
  }

  return { ok: true, summary: summary.trim(), truncated: extracted.truncated };
}

module.exports = { summariseReport };
