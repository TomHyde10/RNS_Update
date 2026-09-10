// Confirmed by a real request/response capture:
//   GET https://api.gleif.org/api/v1/lei-records?filter[isin]=<ISIN>
//   -> { data: [ { attributes: { lei, entity: { legalName: { name } } } } ] }
// GLEIF (the body that issues LEIs) runs this as a real, documented, keyless
// public API - a far more solid foundation than the NSM search endpoint,
// which is reverse-engineered with no documentation at all. Used to resolve
// a company's ISIN (what most people actually track holdings by) to the LEI
// the NSM search requires.
const GLEIF_LEI_RECORDS_URL = 'https://api.gleif.org/api/v1/lei-records';

async function resolveIsinToLei(isin) {
  const url = `${GLEIF_LEI_RECORDS_URL}?${new URLSearchParams({ 'filter[isin]': isin })}`;

  let response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    return { isin, error: `Failed to reach GLEIF: ${err}` };
  }

  if (!response.ok) {
    return { isin, error: `GLEIF returned ${response.status}` };
  }

  const data = await response.json();
  const record = Array.isArray(data.data) ? data.data[0] : null;
  if (!record) {
    return { isin, error: 'No LEI found for this ISIN in GLEIF' };
  }

  const lei = record.attributes && record.attributes.lei;
  const name = record.attributes && record.attributes.entity && record.attributes.entity.legalName && record.attributes.entity.legalName.name;

  if (!lei) {
    return { isin, error: 'GLEIF response was missing the LEI field' };
  }

  return { isin, lei, name: name || null };
}

// One request per ISIN, run in parallel - this only runs when a user
// resolves companies to add (a one-time action per company), not on every
// report refresh, so per-ISIN requests are an acceptable tradeoff against
// the added complexity/risk of guessing at whether GLEIF's filter[isin]
// supports a comma-separated batch in one call (unconfirmed).
async function resolveIsins(isins) {
  return Promise.all(isins.map(resolveIsinToLei));
}

module.exports = { resolveIsinToLei, resolveIsins };
