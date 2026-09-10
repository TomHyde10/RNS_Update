// Fallback companies, used only when /api/reports is called with no `leis`
// query parameter (e.g. hitting the API directly). The web UI always passes
// its own `leis` from the browser's localStorage-backed list, so editing
// this file has no effect on the page itself.
//
// `lei` is the company's Legal Entity Identifier (20 alphanumeric
// characters) - the FCA's National Storage Mechanism has no ISIN field, so
// filings are looked up by LEI, not ISIN. Find a company's LEI by searching
// for it by name at https://data.fca.org.uk (National Storage Mechanism).
module.exports = [
  { lei: '549300UC0QPP7Y0W8056', name: 'Fidelity European Trust plc' },
];
