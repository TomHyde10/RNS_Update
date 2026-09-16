'use strict';

const $ = (id) => document.getElementById(id);

const gbp = (n) =>
  n == null
    ? '—'
    : n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });

const gbpExact = (n) => n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const shortDate = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

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

  tr.append(dateCell, amountCell, removeCell);
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
    .map((tr) => ({
      date: tr.querySelector('.liability-date').value,
      amount: Number(tr.querySelector('.liability-amount').value),
    }))
    .filter((l) => l.date && l.amount > 0);
}

function setStatus(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('error', isError);
}

function stat(label, value, tone) {
  const toneClass = tone ? ` ${tone}` : '';
  return `<div class="stat"><span class="label">${label}</span><span class="value${toneClass}">${value}</span></div>`;
}

function renderSummary(result) {
  const { totals, fullyFunded } = result;
  const cards = [
    stat('Total liabilities', gbp(totals.liabilities)),
    stat('Cost to fund', gbp(totals.cost)),
    stat('Holdings', String(totals.holdingCount)),
    stat('Fully funded', fullyFunded ? 'Yes' : 'No', fullyFunded ? 'good' : 'bad'),
  ];

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
        <td class="num">${gbpExact(h.cost)}</td>
        <td>${shortDate(h.fundsLiability)}</td>
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

function renderProvenance(p, pricing) {
  const bits = [
    `Prices ${p.priceBasis}, dated ${shortDate(p.curveDate)}.`,
    pricing && pricing.pricedRungs
      ? `${pricing.pricedRungs} of ${pricing.pricedRungs + pricing.derivedRungs} rungs bought at a price you supplied.`
      : '',
    p.curveStale ? 'The curve could not be refreshed — this is the last one retrieved.' : '',
    `Gilt universe: ${p.universeSource}${p.universeAsOf ? ` as at ${shortDate(p.universeAsOf)}` : ''}.`,
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
    renderChart(body);
    renderProvenance(body.provenance, body.pricing);
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

// The holdings from the most recent build, so "Add the gilts in this ladder"
// can seed the price table with exactly the shortlist that matters.
let lastHoldings = [];

async function init() {
  $('add-liability').addEventListener('click', () => addLiabilityRow());
  $('add-price').addEventListener('click', () => addPriceRow());
  $('build').addEventListener('click', build);
  $('price-ladder').addEventListener('click', () => {
    for (const holding of lastHoldings) addPriceRow(holding.isin, holding.cleanPrice.toFixed(3));
    $('prices-panel').open = true;
  });

  // Seed with a plausible shape so the page is usable immediately.
  const year = new Date().getUTCFullYear();
  addLiabilityRow(`${year + 2}-09-30`, '25000');
  addLiabilityRow(`${year + 4}-09-30`, '25000');
  addLiabilityRow(`${year + 6}-09-30`, '25000');

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
