// Fetches a report's linked document (from data.fca.org.uk/artefacts/) and
// extracts plain text from it, for lib/summarise.js to hand to an LLM.
// Most filings are PDFs, but a handful come through as an HTML "Direct
// Upload" page instead (see the README's "Known limitations") - detected
// from the response's Content-Type rather than guessed from the URL, since
// NSM's download_link paths don't reliably carry a file extension.
const pdfParse = require('pdf-parse');

// Browser-like but tailored to fetching a document, not the JSON search API
// (see BROWSER_LIKE_HEADERS in fetchReports.js, which sends
// Accept/Content-Type suited to that POST instead).
const DOCUMENT_FETCH_HEADERS = {
  accept: 'application/pdf,text/html,*/*',
  'user-agent': 'Mozilla/5.0 (compatible; rns-update/1.0)',
};

// Keeps the prompt sent to a (likely resource-constrained, self-hosted)
// model reasonably sized - a full filing can run to tens of thousands of
// words, most of which a summary doesn't need. Configurable since context
// window and practical inference speed vary a lot by model/hardware.
const MAX_INPUT_CHARS = parseInt(process.env.LLM_MAX_INPUT_CHARS, 10) || 8000;

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

async function extractDocumentText(url) {
  let response;
  try {
    response = await fetch(url, { headers: DOCUMENT_FETCH_HEADERS });
  } catch (err) {
    return { error: `Failed to fetch the document: ${err.message || err}` };
  }

  if (!response.ok) {
    return { error: `Document fetch returned ${response.status}` };
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());

  let text;
  try {
    if (contentType.includes('pdf') || url.toLowerCase().endsWith('.pdf')) {
      text = (await pdfParse(buffer)).text;
    } else {
      text = stripHtml(buffer.toString('utf8'));
    }
  } catch (err) {
    return { error: `Failed to parse the document: ${err.message || err}` };
  }

  text = text.replace(/\s+/g, ' ').trim();
  if (!text) {
    return { error: 'No extractable text found in the document.' };
  }

  const truncated = text.length > MAX_INPUT_CHARS;
  return { text: truncated ? text.slice(0, MAX_INPUT_CHARS) : text, truncated };
}

module.exports = { extractDocumentText };
