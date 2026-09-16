'use strict';

const $ = (id) => document.getElementById(id);

const gbp = (n) =>
  n == null
    ? '—'
    : n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });

const gbpExact = (n) => n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pct = (n, dp = 3) => (n == null ? '—' : `${(n * 100).toFixed(dp)}%`);
const years = (n) => (n == null ? '—' : `${n.toFixed(2)}y`);
// Cost per £1 delivered differs between rungs in the fourth decimal, so the gap
// to the runner-up is shown in basis points of that cost - the unit it is
// actually decided in.
const basisPoints = (n) => `${(n * 10000).toFixed(1)}bp`;

const shortDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

// The repeating shapes people actually fund: school fees every September for
// five years, drawdown every year for twenty-five. One row, not twenty-five.
const REPEATS = [
  ['', 'Once'],
  ['month', 'Monthly'],
  ['quarter', 'Quarterly'],
  ['half-year', 'Half-yearly'],
  ['year', 'Yearly'],
];

function addLiabilityRow(date = '', amount = '') {
  const tbody = $('liabilities').querySelector('tbody');
  const tr = document.createElement('tr');

  const dateCell = document.createElement('td');
  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'liability-date';
  dateInput.value = date;
  dateCell.appendChild(dateInput);

  const amountCell = document.createElement('td');
  const amountInput = document.createElement('input');
  amountInput.type = 'number';
  amountInput.min = '0';
  amountInput.step = '100';
  amountInput.className = 'liability-amount';
  amountInput.placeholder = '25000';
  amountInput.value = amount;
  amountCell.appendChild(amountInput);

  const repeatCell = document.createElement('td');
  const repeatSelect = document.createElement('select');
  repeatSelect.className = 'liability-repeat';
  for (const [value, label] of REPEATS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    repeatSelect.appendChild(option);
  }
  repeatCell.appendChild(repeatSelect);

  const countCell = document.createElement('td');
  const countInput = document.createElement('input');
  countInput.type = 'number';
  countInput.min = '1';
  countInput.max = '600';
  countInput.step = '1';
  countInput.className = 'liability-count';
  countInput.value = '1';
  countInput.disabled = true;
  countCell.appendChild(countInput);

  // A count only means anything once there is something to repeat, and it must
  // go back to 1 if the repeat is cleared - otherwise a stale count silently
  // survives as "once".
  repeatSelect.addEventListener('change', () => {
    countInput.disabled = !repeatSelect.value;
    if (!repeatSelect.value) countInput.value = '1';
    else if (countInput.value === '1') countInput.value = '5';
  });

  const removeCell = document.createElement('td');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    tr.remove();
    if (!tbody.children.length) addLiabilityRow();
  });
  removeCell.appendChild(remove);

  tr.append(dateCell, amountCell, repeatCell, countCell, removeCell);
  tbody.appendChild(tr);
}

function addPriceRow(isin = '', clean = '') {
  const tbody = $('prices').querySelector('tbody');
  if ([...tbody.querySelectorAll('.price-isin')].some((i) => i.value.trim().toUpperCase() === isin)) return;

  const tr = document.createElement('tr');

  const isinCell = document.createElement('td');
  const isinInput = document.createElement('input');
  isinInput.type = 'text';
  isinInput.className = 'price-isin';
  isinInput.setAttribute('list', 'universe-isins');
  isinInput.placeholder = 'GB00B16NNR78';
  isinInput.value = isin;
  isinCell.appendChild(isinInput);

  const cleanCell = document.createElement('td');
  const cleanInput = document.createElement('input');
  cleanInput.type = 'number';
  cleanInput.min = '1';
  cleanInput.max = '250';
  cleanInput.step = '0.01';
  cleanInput.className = 'price-clean';
  cleanInput.placeholder = '96.42';
  cleanInput.value = clean;
  cleanCell.appendChild(cleanInput);

  const removeCell = document.createElement('td');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => tr.remove());
  removeCell.appendChild(remove);

  tr.append(isinCell, cleanCell, removeCell);
  tbody.appendChild(tr);
}

function addOwnedRow(isin = '', nominal = '') {
  const tbody = $('owned').querySelector('tbody');
  const tr = document.createElement('tr');

  const isinCell = document.createElement('td');
  const isinInput = document.createElement('input');
  isinInput.type = 'text';
  isinInput.className = 'owned-isin';
  isinInput.setAttribute('list', 'universe-isins');
  isinInput.placeholder = 'GB00B16NNR78';
  isinInput.value = isin;
  isinCell.appendChild(isinInput);

  const nominalCell = document.createElement('td');
  const nominalInput = document.createElement('input');
  nominalInput.type = 'number';
  nominalInput.min = '0';
  nominalInput.step = '100';
  nominalInput.className = 'owned-nominal';
  nominalInput.placeholder = '10000';
  nominalInput.value = nominal;
  nominalCell.appendChild(nominalInput);

  const removeCell = document.createElement('td');
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'link';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => tr.remove());
  removeCell.appendChild(remove);

  tr.append(isinCell, nominalCell, removeCell);
  tbody.appendChild(tr);
}

function readExistingHoldings() {
  return [...document.querySelectorAll('#owned tbody tr')]
    .map((tr) => ({
      isin: tr.querySelector('.owned-isin').value.trim().toUpperCase(),
      nominal: Number(tr.querySelector('.owned-nominal').value),
    }))
    .filter((h) => h.isin && h.nominal > 0);
}

// Only fully-completed rows are sent. A half-typed row is a row in progress,
// not a validation error to shout about.
function readObservedPrices() {
  return [...document.querySelectorAll('#prices tbody tr')]
    .map((tr) => ({
      isin: tr.querySelector('.price-isin').value.trim().toUpperCase(),
      clean: Number(tr.querySelector('.price-clean').value),
    }))
    .filter((p) => p.isin && Number.isFinite(p.clean) && p.clean > 0);
}

function readLiabilities() {
  return [...document.querySelectorAll('#liabilities tbody tr')]
    .map((tr) => {
      const every = tr.querySelector('.liability-repeat').value;
      const count = Number(tr.querySelector('.liability-count').value);
      return {
        date: tr.querySelector('.liability-date').value,
        amount: Number(tr.querySelector('.liability-amount').value),
        // Omitted entirely rather than sent as a repeat of one, so a plain
        // liability goes over the wire as a plain liability.
        ...(every && count > 1 ? { repeat: { every, count } } : {}),
      };
    })
    .filter((l) => l.date && l.amount > 0);
}

function setStatus(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('error', isError);
}

function stat(label, value, tone, title) {
  const toneClass = tone ? ` ${tone}` : '';
  const hint = title ? ` title="${title}"` : '';
  return `<div class="stat"${hint}><span class="label">${label}</span><span class="value${toneClass}">${value}</span></div>`;
}

function renderSummary(result) {
  const { totals, fullyFunded } = result;
  const cards = [
    stat('Total liabilities', gbp(totals.liabilities)),
    stat('Cost to fund', gbp(totals.cost), '', 'What still has to be bought, at these prices.'),
    ...(totals.existingCount
      ? [stat('Already owned', gbp(totals.existingValue), '', `${totals.existingCount} holding(s), valued not costed.`)]
      : []),
    stat('Holdings', String(totals.holdingCount)),
    stat('Fully funded', fullyFunded ? 'Yes' : 'No', fullyFunded ? 'good' : 'bad'),
  ];

  // Cash-flow matching should land the assets' duration close to the
  // liabilities' by construction. A wide gap means the universe could not match
  // the dates, and the ladder is more exposed to a move in rates than a matched
  // one should be.
  const { assets, liabilities: liabilitySide, durationGap } = result.analytics;
  cards.push(
    stat(
      'Duration gap',
      `${durationGap >= 0 ? '+' : ''}${durationGap.toFixed(2)}y`,
      Math.abs(durationGap) <= 0.5 ? 'good' : '',
      `Assets ${assets.duration.toFixed(2)}y against liabilities ${liabilitySide.duration.toFixed(2)}y. ` +
        'Close to zero is what cash-flow matching is for.'
    )
  );

  if (totals.portfolioValue != null) {
    const surplus = totals.surplus;
    cards.splice(
      2,
      0,
      stat(surplus >= 0 ? 'Surplus' : 'Shortfall', gbp(Math.abs(surplus)), surplus >= 0 ? 'good' : 'bad')
    );
  }

  $('summary').innerHTML = cards.join('');

  const warnings = [
    ...result.warnings.map((w) => w.message),
    ...result.unfunded.map(
      (u) => `${shortDate(u.date)}: ${gbp(u.shortfall)} not funded${u.reason ? ` — ${u.reason}` : ''}.`
    ),
  ];
  $('warnings').innerHTML = warnings.map((w) => `<div class="warning">${w}</div>`).join('');
}

function renderHoldings(holdings) {
  const tbody = $('holdings').querySelector('tbody');
  tbody.innerHTML = holdings
    .map(
      (h) => `<tr>
        <td>${h.name}</td>
        <td><code>${h.isin}</code></td>
        <td class="num">${h.coupon.toFixed(3)}%</td>
        <td>${shortDate(h.redemption)}</td>
        <td class="num">${h.nominal.toLocaleString('en-GB')}</td>
        <td class="num">${h.cleanPrice.toFixed(3)}${
          h.priceSource === 'observed'
            ? ' <span class="pill yes" title="A price you supplied">quoted</span>'
            : ' <span class="pill derived" title="Derived from the Bank of England curve">derived</span>'
        }</td>
        <td class="num">${h.accrued.toFixed(3)}</td>
        <td class="num">${pct(h.grossRedemptionYield)}</td>
        <td class="num">${years(h.modifiedDuration)}${
          h.beyondCurve ? ' <span class="pill derived" title="Redeems past the end of the curve">extrapolated</span>' : ''
        }</td>
        <td class="num">${gbpExact(h.cost)}</td>
        <td>${shortDate(h.fundsLiability)}</td>
      </tr>`
    )
    .join('');
}

function renderExisting(existing) {
  $('existing-panel').hidden = !existing.length;
  if (!existing.length) return;

  $('existing').querySelector('tbody').innerHTML = existing
    .map(
      (h) => `<tr>
        <td>${h.name}</td>
        <td><code>${h.isin}</code></td>
        <td class="num">${h.coupon.toFixed(3)}%</td>
        <td>${shortDate(h.redemption)}</td>
        <td class="num">${h.nominal.toLocaleString('en-GB')}</td>
        <td class="num">${h.value == null ? '—' : gbpExact(h.value)}</td>
      </tr>`
    )
    .join('');
}

function renderTax(tax) {
  $('tax-panel').hidden = !tax.byYear.length;
  if (!tax.byYear.length) return;

  $('tax-years').querySelector('tbody').innerHTML = tax.byYear
    .map(
      (row) => `<tr>
        <td>${row.taxYear}${row.estimated ? ' <span class="pill derived" title="No published bands for this year - the most recent are held flat">estimated</span>' : ''}</td>
        <td class="num">${gbpExact(row.coupons)}</td>
        <td class="num">${gbpExact(row.zeroRated)}</td>
        <td class="num">${gbpExact(row.taxable)}</td>
        <td class="num">${gbpExact(row.tax)}</td>
        <td class="num">${pct(row.effectiveRate, 1)}</td>
      </tr>`
    )
    .join('');

  const notes = [
    `Total coupon tax ${gbp(tax.total)} on ${gbp(tax.couponIncome)} of coupon income.`,
    tax.otherIncome == null
      ? 'No other income stated, so the starting rate for savings is assumed unavailable - the cautious assumption, which can only overstate the tax.'
      : `Assuming ${gbp(tax.otherIncome)} of other taxable income.`,
    tax.estimatedYears.length
      ? `Allowances for ${tax.estimatedYears.length} later tax year(s) are not published; the ${tax.allowancesCheckedAgainst} figures are held flat.`
      : '',
    tax.accruedIncomeScheme ? 'Accrued Income Scheme relief applied to each first coupon.' : '',
  ];
  $('tax-note').textContent = notes.filter(Boolean).join(' ');
}

function renderSelection(selection) {
  const tbody = $('selection').querySelector('tbody');
  // buildLadder works backwards, so `selection` arrives latest-first.
  tbody.innerHTML = [...selection]
    .sort((a, b) => a.liability.localeCompare(b.liability))
    .map(
      (s) => `<tr>
        <td>${shortDate(s.liability)}</td>
        <td>${s.chosen}</td>
        <td class="num">${s.perUnit.toFixed(5)}</td>
        <td>${s.runnerUp ? s.runnerUp.name : '—'}</td>
        <td class="num">${s.runnerUp ? basisPoints(s.runnerUp.perUnit - s.perUnit) : '—'}</td>
        <td class="num">${s.candidates}</td>
      </tr>`
    )
    .join('');
}

function renderCoverage(coverage) {
  const tbody = $('coverage').querySelector('tbody');
  tbody.innerHTML = coverage
    .map(
      (c) => `<tr>
        <td>${shortDate(c.date)}</td>
        <td class="num">${gbpExact(c.amount)}</td>
        <td><span class="pill ${c.covered ? 'yes' : 'no'}">${c.covered ? 'Covered' : 'Short'}</span></td>
        <td class="num">${gbpExact(c.surplusCarried)}</td>
      </tr>`
    )
    .join('');
}

// Cash inflows as bars, liabilities as outlined markers on the same axis, so
// the question the ladder exists to answer - does the money arrive before it
// is needed - is legible at a glance.
function renderChart(result) {
  const flows = result.cashflows;
  const liabilities = result.coverage;
  if (!flows.length) {
    $('chart').innerHTML = '';
    return;
  }

  const width = Math.max(680, flows.length * 14 + 80);
  const height = 240;
  const pad = { top: 16, right: 16, bottom: 34, left: 64 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const dates = [...flows.map((f) => f.date), ...liabilities.map((l) => l.date)];
  const min = Date.parse(`${dates.reduce((a, b) => (a < b ? a : b))}T00:00:00Z`);
  const max = Date.parse(`${dates.reduce((a, b) => (a > b ? a : b))}T00:00:00Z`);
  const span = Math.max(1, max - min);
  const maxAmount = Math.max(...flows.map((f) => f.amount), ...liabilities.map((l) => l.amount));

  const x = (iso) => pad.left + ((Date.parse(`${iso}T00:00:00Z`) - min) / span) * plotW;
  const y = (amount) => pad.top + plotH - (amount / maxAmount) * plotH;

  const bars = flows
    .map((f) => {
      const h = Math.max(1, plotH - (y(f.amount) - pad.top));
      return `<rect class="chart-bar-flow" x="${(x(f.date) - 2).toFixed(1)}" y="${y(f.amount).toFixed(1)}" width="4" height="${h.toFixed(1)}"><title>${shortDate(f.date)}: ${gbp(f.amount)} in</title></rect>`;
    })
    .join('');

  const marks = liabilities
    .map((l) => {
      const cx = x(l.date);
      const cy = y(l.amount);
      return `<path class="chart-bar-liability" d="M${(cx - 6).toFixed(1)} ${cy.toFixed(1)} L${cx.toFixed(1)} ${(cy - 8).toFixed(1)} L${(cx + 6).toFixed(1)} ${cy.toFixed(1)} Z"><title>${shortDate(l.date)}: ${gbp(l.amount)} due</title></path>`;
    })
    .join('');

  const ticks = [0, 0.5, 1]
    .map((frac) => {
      const value = maxAmount * frac;
      const yy = y(value);
      return `<text class="chart-label" x="${pad.left - 8}" y="${(yy + 3).toFixed(1)}" text-anchor="end">${gbp(value)}</text>`;
    })
    .join('');

  // Labelled off every plotted date, not just the inflows: a liability funded
  // by an earlier redemption sits beyond the last cash flow, and labelling
  // only the flows leaves it floating past the end of the axis.
  const years = [...new Set(dates.map((d) => d.slice(0, 4)))].sort();
  const yearLabels = years
    .map((yr) => {
      const xx = x(`${yr}-01-01`);
      if (xx < pad.left || xx > width - pad.right) return '';
      return `<text class="chart-label" x="${xx.toFixed(1)}" y="${height - 12}" text-anchor="middle">${yr}</text>`;
    })
    .join('');

  $('chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
      aria-label="Cash inflows from the ladder against the liabilities they fund">
      <line class="chart-axis" x1="${pad.left}" y1="${pad.top + plotH}" x2="${width - pad.right}" y2="${pad.top + plotH}" />
      ${ticks}${bars}${marks}${yearLabels}
    </svg>`;
}

function renderProvenance(p, pricing, tax) {
  const bits = [
    `Prices ${p.priceBasis}, dated ${shortDate(p.curveDate)}.`,
    pricing && pricing.pricedRungs
      ? `${pricing.pricedRungs} of ${pricing.pricedRungs + pricing.derivedRungs} rungs bought at a price you supplied.`
      : '',
    p.curveStale ? 'The curve could not be refreshed — this is the last one retrieved.' : '',
    `Gilt universe: ${p.universeSource}${p.universeAsOf ? ` as at ${shortDate(p.universeAsOf)}` : ''}.`,
    tax && tax.marginalRate > 0
      ? tax.accruedIncomeScheme
        ? 'Coupons taxed at your marginal rate, with Accrued Income Scheme relief on each first coupon.'
        : `Coupons taxed at your marginal rate in full; the Accrued Income Scheme was not applied (${
            tax.totalNominal <= tax.nominalThreshold
              ? `£${tax.totalNominal.toLocaleString('en-GB')} nominal is within the £${tax.nominalThreshold.toLocaleString('en-GB')} threshold`
              : 'you turned it off'
          }).`
      : 'No tax on coupons at a 0% marginal rate.',
    'Indicative only: these are not dealable prices and exclude dealing costs and commission.',
  ];
  $('provenance').textContent = bits.filter(Boolean).join(' ');
}

async function build() {
  const liabilities = readLiabilities();
  if (!liabilities.length) {
    setStatus('Add at least one liability with a date and an amount.', true);
    return;
  }

  const button = $('build');
  button.disabled = true;
  setStatus('Building…');

  const portfolioValue = $('portfolio-value').value;

  try {
    const res = await fetch('api/ladder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        liabilities,
        portfolioValue: portfolioValue === '' ? null : Number(portfolioValue),
        marginalRate: Number($('marginal-rate').value),
        lotSize: Number($('lot-size').value),
        bufferBusinessDays: Number($('buffer').value),
        observedPrices: readObservedPrices(),
        existingHoldings: readExistingHoldings(),
        otherIncome: $('other-income').value === '' ? null : Number($('other-income').value),
        // 'auto' rather than true: the scheme only catches holdings over
        // £5,000 nominal, and the server decides that from the ladder it builds.
        accruedIncomeScheme: $('ais').checked ? 'auto' : false,
      }),
    });

    const body = await res.json();
    if (!res.ok) {
      const detail = Array.isArray(body.details) ? body.details.join('; ') : body.details || '';
      setStatus(`${body.error}${detail ? `: ${detail}` : ''}`, true);
      return;
    }

    renderSummary(body);
    renderHoldings(body.holdings);
    renderCoverage(body.coverage);
    renderExisting(body.existing);
    renderTax(body.tax);
    renderSelection(body.diagnostics.selection);
    renderChart(body);
    renderProvenance(body.provenance, body.pricing, body.tax);
    // The gilts this ladder picked are the shortlist worth going and getting
    // real prices for, so make pre-filling them one click.
    lastHoldings = body.holdings;
    $('price-ladder').disabled = !lastHoldings.length;
    $('results').hidden = false;
    setStatus(`Settled ${shortDate(body.settlement)} against the ${shortDate(body.curveDate)} curve.`);
  } catch (err) {
    setStatus(`Could not reach the server: ${err.message}`, true);
  } finally {
    button.disabled = false;
  }
}

// Exports are POSTed rather than linked, because the plan has to travel with
// the request and a plan does not belong in a URL that a browser will remember.
// The response is a file, so it goes through a blob and a synthetic click.
async function download(path, filename) {
  const plan = readPlan();
  if (!plan.liabilities.length) {
    setStatus('Build a ladder before exporting it.', true);
    return;
  }

  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setStatus(body.error || `Export failed: HTTP ${res.status}`, true);
      return;
    }

    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${filename}.`);
  } catch (err) {
    setStatus(`Could not export: ${err.message}`, true);
  }
}

// --- Plans -----------------------------------------------------------------
//
// A plan is what was entered, not what came back: reopening one rebuilds it
// against today's curve rather than showing a stale answer that merely looks
// current.

function readPlan() {
  const portfolioValue = $('portfolio-value').value;
  return {
    liabilities: readLiabilities(),
    observedPrices: readObservedPrices(),
    existingHoldings: readExistingHoldings(),
    portfolioValue: portfolioValue === '' ? null : Number(portfolioValue),
    marginalRate: Number($('marginal-rate').value),
    lotSize: Number($('lot-size').value),
    bufferBusinessDays: Number($('buffer').value),
    otherIncome: $('other-income').value === '' ? null : Number($('other-income').value),
    accruedIncomeScheme: $('ais').checked ? 'auto' : false,
  };
}

function writePlan(plan) {
  $('portfolio-value').value = plan.portfolioValue == null ? '' : plan.portfolioValue;
  $('marginal-rate').value = String(plan.marginalRate == null ? 0 : plan.marginalRate);
  if (plan.lotSize != null) $('lot-size').value = plan.lotSize;
  if (plan.bufferBusinessDays != null) $('buffer').value = plan.bufferBusinessDays;
  $('other-income').value = plan.otherIncome == null ? '' : plan.otherIncome;
  $('ais').checked = plan.accruedIncomeScheme !== false;

  for (const table of ['liabilities', 'prices', 'owned']) {
    $(table).querySelector('tbody').innerHTML = '';
  }
  for (const l of plan.liabilities || []) {
    addLiabilityRow(l.date, l.amount);
    if (!l.repeat) continue;
    const row = $('liabilities').querySelector('tbody').lastElementChild;
    const select = row.querySelector('.liability-repeat');
    const count = row.querySelector('.liability-count');
    select.value = l.repeat.every;
    count.disabled = false;
    count.value = l.repeat.count;
  }
  if (!(plan.liabilities || []).length) addLiabilityRow();

  for (const p of plan.observedPrices || []) addPriceRow(p.isin, p.clean);
  for (const h of plan.existingHoldings || []) addOwnedRow(h.isin, h.nominal);
  if ((plan.observedPrices || []).length) $('prices-panel').open = true;
  if ((plan.existingHoldings || []).length) $('holdings-panel').open = true;
}

async function share() {
  const plan = readPlan();
  if (!plan.liabilities.length) {
    setStatus('Add at least one liability before sharing.', true);
    return;
  }

  try {
    const res = await fetch('api/plan/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plan),
    });
    const body = await res.json();
    if (!res.ok) {
      setStatus(body.error, true);
      return;
    }

    const link = new URL(window.location.href);
    link.search = `?plan=${body.token}`;
    link.hash = '';
    // Clipboard access needs a secure context and can be refused outright, so
    // the address bar is updated either way - the link is then just there.
    window.history.replaceState(null, '', link.search);
    try {
      await navigator.clipboard.writeText(link.href);
      setStatus('Share link copied. It carries the whole plan, encrypted.');
    } catch {
      setStatus('Share link is now in the address bar - copy it from there.');
    }
  } catch (err) {
    setStatus(`Could not create a share link: ${err.message}`, true);
  }
}

async function refreshSavedPlans(selectId) {
  const select = $('saved-plans');
  let body;
  try {
    const res = await fetch('api/plans');
    // 501 is the expected answer on a deployment with no database, not a
    // failure: the save controls simply stay hidden.
    if (!res.ok) return false;
    body = await res.json();
  } catch {
    return false;
  }

  select.innerHTML =
    '<option value="">Saved plans&hellip;</option>' +
    body.plans.map((p) => `<option value="${p.id}">${p.label}</option>`).join('');
  if (selectId) select.value = selectId;
  savedPlans = body.plans;
  showPlanControls();
  return true;
}

// Watching, deleting and the watch state all belong to whichever plan is
// selected, so they move together rather than being toggled in three places.
function showPlanControls() {
  const id = $('saved-plans').value;
  const record = savedPlans.find((p) => p.id === id);
  $('delete-plan').hidden = !record;
  $('watch-label').hidden = !record;
  $('watch').checked = Boolean(record && record.alertsEnabled);
}

async function setWatch(enabled) {
  const id = $('saved-plans').value;
  if (!id) return;
  try {
    const res = await fetch(`api/plans/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alertsEnabled: enabled }),
    });
    if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
    const record = savedPlans.find((p) => p.id === id);
    if (record) record.alertsEnabled = enabled;
    setStatus(
      enabled
        ? 'Watching. This plan is re-costed daily against the new curve, and you are emailed when it moves.'
        : 'No longer watching this plan.'
    );
  } catch (err) {
    $('watch').checked = !enabled; // put the box back where it was
    setStatus(`Could not change watching: ${err.message}`, true);
  }
}

async function savePlan() {
  const plan = readPlan();
  if (!plan.liabilities.length) {
    setStatus('Add at least one liability before saving.', true);
    return;
  }

  const existingId = $('saved-plans').value;
  const suggested = existingId
    ? $('saved-plans').selectedOptions[0].textContent
    : `Plan of ${new Date().toLocaleDateString('en-GB')}`;
  const label = window.prompt('Name this plan', suggested);
  if (label == null) return;

  // Saving under the same name as the plan currently open updates it; a new
  // name makes a new plan, so renaming never silently forks.
  const id = existingId && label === suggested ? existingId : undefined;

  try {
    const res = await fetch('api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, plan, id }),
    });
    const body = await res.json();
    if (!res.ok) {
      setStatus(body.error, true);
      return;
    }
    await refreshSavedPlans(body.plan.id);
    setStatus(`Saved as "${body.plan.label}".`);
  } catch (err) {
    setStatus(`Could not save: ${err.message}`, true);
  }
}

async function loadSavedPlan(id) {
  if (!id) {
    showPlanControls();
    return;
  }
  try {
    const body = await fetch(`api/plans/${encodeURIComponent(id)}`).then((r) => r.json());
    if (!body.plan) {
      setStatus('That plan could not be loaded.', true);
      return;
    }
    writePlan(body.plan.plan);
    showPlanControls();
    setStatus(`Loaded "${body.plan.label}". Build it to cost it against today's curve.`);
  } catch (err) {
    setStatus(`Could not load that plan: ${err.message}`, true);
  }
}

async function deleteSavedPlan() {
  const select = $('saved-plans');
  const id = select.value;
  if (!id) return;
  if (!window.confirm(`Delete "${select.selectedOptions[0].textContent}"?`)) return;

  await fetch(`api/plans/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await refreshSavedPlans();
  select.value = '';
  showPlanControls();
  setStatus('Plan deleted.');
}

// The saved plans as last listed, so the watch box and the delete button can
// reflect the selected one without a round trip each time.
let savedPlans = [];

// The holdings from the most recent build, so "Add the gilts in this ladder"
// can seed the price table with exactly the shortlist that matters.
let lastHoldings = [];

async function init() {
  $('add-liability').addEventListener('click', () => addLiabilityRow());
  $('add-price').addEventListener('click', () => addPriceRow());
  $('add-owned').addEventListener('click', () => addOwnedRow());
  $('build').addEventListener('click', build);
  $('share').addEventListener('click', share);
  $('save').addEventListener('click', savePlan);
  $('delete-plan').addEventListener('click', deleteSavedPlan);
  $('saved-plans').addEventListener('change', (event) => loadSavedPlan(event.target.value));
  $('watch').addEventListener('change', (event) => setWatch(event.target.checked));
  $('export-dealing').addEventListener('click', () =>
    download('api/export/dealing-list.csv', 'gilt-dealing-list.csv')
  );
  $('export-cashflows').addEventListener('click', () =>
    download('api/export/cashflows.csv', 'gilt-cashflows.csv')
  );
  $('export-calendar').addEventListener('click', () =>
    download('api/export/calendar.ics', 'gilt-ladder.ics')
  );
  $('price-ladder').addEventListener('click', () => {
    for (const holding of lastHoldings) addPriceRow(holding.isin, holding.cleanPrice.toFixed(3));
    $('prices-panel').open = true;
  });

  // Seed with a plausible shape so the page is usable immediately.
  const year = new Date().getUTCFullYear();
  addLiabilityRow(`${year + 2}-09-30`, '25000');
  addLiabilityRow(`${year + 4}-09-30`, '25000');
  addLiabilityRow(`${year + 6}-09-30`, '25000');

  // A shared link wins over the seeded example: someone following a link came
  // for that plan, not for a demonstration.
  const token = new URLSearchParams(window.location.search).get('plan');
  if (token) {
    try {
      const body = await fetch(`api/plan?t=${encodeURIComponent(token)}`).then((r) => r.json());
      if (body.plan) {
        writePlan(body.plan);
        setStatus('Opened a shared plan. Build it to cost it against today\'s curve.');
      } else {
        setStatus(body.error || 'That share link could not be opened.', true);
      }
    } catch (err) {
      setStatus(`Could not open that share link: ${err.message}`, true);
    }
  }

  // Saving needs a database. Where there is none the controls stay hidden
  // rather than offering something that would fail on use.
  if (await refreshSavedPlans()) {
    $('save').hidden = false;
    $('saved-plans').hidden = false;
  }

  try {
    const universe = await fetch('api/universe').then((r) => r.json());
    if (universe.source === 'sample') $('sample-banner').hidden = false;
    $('universe-isins').innerHTML = universe.gilts
      .map((g) => `<option value="${g.isin}">${g.name}</option>`)
      .join('');
  } catch {
    // The banner is a safety net, not a blocker - if this call fails the build
    // request will surface the problem properly.
  }
}

init();
