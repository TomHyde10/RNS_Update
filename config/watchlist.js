// Fallback companies, used only when /api/reports is called with no `leis`
// query parameter (e.g. hitting the API directly). The web UI always passes
// its own `leis` from the browser's localStorage-backed list, so editing
// this file has no effect on the page itself.
//
// `lei` is the company's Legal Entity Identifier (20 alphanumeric
// characters) - the FCA's National Storage Mechanism has no ISIN field, so
// filings are looked up by LEI, not ISIN. Use the "Add multiple companies
// by ISIN" box on the page to resolve ISINs to LEIs via GLEIF.
//
// `name` is left blank throughout below - normalise() in lib/fetchReports.js
// falls back to the live `company` field from the NSM response when a
// watchlist entry has no name, so there's no need to hardcode one.
//
// This batch of 21 LEIs came from resolving a pasted list of ISINs. Two are
// independently confirmed correct (549300HV0VXCRONER808 = Edinburgh
// Investment Trust, 549300UC0QPP7Y0W8056 = Fidelity European Trust), but
// both sat one position later than expected against the original ISIN
// order, suggesting the list may have an extra/misplaced entry rather than
// being a clean 1:1 positional match - check the debug panel against what
// you actually expect to see before treating this list as final.
module.exports = [
  { lei: '5299008VJFXCUD2EG312', name: '' },
  { lei: '549300HV0VXCRONER808', name: 'Edinburgh Investment Trust plc' },
  { lei: '213800F3NOTF47H6AO55', name: '' },
  { lei: '549300XODK7D2K2KYV43', name: '' },
  { lei: '549300PXALXKUMU9JM18', name: '' },
  { lei: '549300QNAI4XRPEB4G65', name: '' },
  { lei: '5493007GCUW7G2BKY360', name: '' },
  { lei: '549300UC0QPP7Y0W8056', name: 'Fidelity European Trust plc' },
  { lei: '213800G37DCS3Q9IJM38', name: '' },
  { lei: '529900S0Y9ZINCHB3O93', name: '' },
  { lei: '5493007C3I0O5PJKR078', name: '' },
  { lei: '549300NF03XVC5IFB447', name: '' },
  { lei: '5493003YBCY4W1IMJU04', name: '' },
  { lei: '549300TN1O5392UC4K19', name: '' },
  { lei: '549300OMDPMJU23SSH75', name: '' },
  { lei: '2138008U8QPGAESFYA48', name: '' },
  { lei: '5493006R74BNJSJKCB17', name: '' },
  { lei: 'VLGEI9B8R0REWKB0LN95', name: '' },
  { lei: '549300SSPK3AXNJOC673', name: '' },
  { lei: '549300OPJXU72JMCYU09', name: '' },
  { lei: '5493002NMTB70RZBXO96', name: '' },
];
