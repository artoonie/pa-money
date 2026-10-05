/* PA Money front end. Plain JS, no build step. Routes render into <main>. */
(() => {
  'use strict';
  const main = document.getElementById('main');
  let META = null;
  let metaPromise = null;
  // Pages call this with their own data promise so the two requests overlap.
  const withMeta = async (dataPromise) => { const [, d] = await Promise.all([metaPromise, dataPromise]); return d; };
  // ?theme=light|dark pins the color scheme; otherwise the OS preference applies.
  const themeParam = new URLSearchParams(location.search).get('theme');
  if (themeParam === 'light' || themeParam === 'dark') document.documentElement.dataset.theme = themeParam;

  // ---- utilities ---------------------------------------------------------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  const moneyShort = (n) => {
    n = Number(n) || 0;
    const a = Math.abs(n);
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
    return '$' + Math.round(n).toLocaleString('en-US');
  };
  const int = (n) => (Number(n) || 0).toLocaleString('en-US');
  const pct = (a, b) => (b ? (100 * a / b) : 0);
  const fmtPct = (p) => (p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p > 0 ? '<1' : '0') + '%';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (d) => {
    if (!d) return '';
    const [y, m, day] = d.split('-').map(Number);
    return `${MONTHS[m - 1] || ''} ${day || ''}, ${y}`;
  };
  const look = (kind, code) => (META && META.lookups && META.lookups[kind] && META.lookups[kind][code ?? '']) || null;
  const label = (kind, code, dflt) => { const l = look(kind, code); return l ? l.label : (dflt ?? code ?? ''); };
  const ACRONYMS = new Set(['AG', 'DA', 'PA', 'US', 'USA', 'PAC', 'LLC', 'LLP', 'LP', 'PC', 'PLLC', 'DSA', 'SEIU', 'AFSCME', 'UFCW', 'IBEW', 'PSEA', 'RSLC', 'DGA', 'RGA', 'DLCC', 'RLCC', 'HRCC', 'HDCC', 'SRCC', 'SDCC', 'CWA', 'AFL', 'CIO', 'UAW', 'GOP', 'NRA', 'NEA', 'AFT', 'IUOE', 'IBT', 'UA', 'DC', 'NY', 'NJ', 'MD', 'DE', 'OH', 'WV', 'VA', 'II', 'III', 'IV', 'TV', 'CPA', 'MD', 'DDS', 'DMD', 'DVM', 'ESQ', 'JR', 'SR', 'COPE', 'PEL', 'UPMC', 'AHN', 'IBPO', 'FOP', 'IAFF', 'PSSU', 'TWU', 'ATU', 'ILA', 'BCTGM', 'UMWA', 'USW', 'NRCC', 'DCCC', 'DNC', 'RNC', 'EMILY', 'ACLU', 'ADL', 'AIPAC', 'MMA', 'HVAC', 'IT', 'RN', 'LPN', 'CRNA', 'DO', 'PHD', 'MBA', 'JD', 'HR', 'CEO', 'CFO', 'COO', 'CTO', 'VP', 'SVP', 'EVP', 'GM', 'OB', 'GYN', 'ENT', 'ER', 'ICU']);
  const SMALL = new Set(['of', 'for', 'and', 'the', 'to', 'at', 'in', 'on', 'by', 'a', 'an', 'or']);
  const titleCase = (s) => String(s || '').toLowerCase().split(/(\s+|\/|-|\()/).map((w, i) => {
    if (!w || /^[\s\/\-(]+$/.test(w)) return w;
    const up = w.replace(/[^a-z]/g, '').toUpperCase();
    if (ACRONYMS.has(up) && up.length === w.replace(/[^a-z]/gi, '').length) return w.toUpperCase();
    if (i > 0 && SMALL.has(w)) return w;
    return w.replace(/^([^a-z]*)mc([a-z])/, (m, pre, c) => pre + 'Mc' + c.toUpperCase()).replace(/^([^a-zA-Z]*)([a-z])/, (m, pre, c) => pre + c.toUpperCase()).replace(/\.([a-z])/g, (m, c) => '.' + c.toUpperCase());
  }).join('');
  const niceName = (s) => (s && s === s.toUpperCase() && /[A-Z]/.test(s) ? titleCase(s) : s);
  const place = (city, state) => [niceName(city), state].filter(Boolean).join(', ');

  async function api(path) {
    const r = await fetch('/api' + path);
    if (!r.ok) throw new Error(`API ${r.status}`);
    return r.json();
  }

  function filerTypeBadge(f) {
    const t = String(f.filer_type || '');
    if (t === '1') return `<span class="badge b-blue">Candidate</span>`;
    if (t === '2') return `<span class="badge b-purple">Committee</span>`;
    if (t === '3') return `<span class="badge b-gray">Lobbyist</span>`;
    return '';
  }
  function partyBadge(p) { return p ? `<span class="badge b-gray">${esc(p)}</span>` : ''; }
  function kindBadge(k) {
    return { committee: '<span class="badge b-purple">Committee</span>', individual: '<span class="badge b-green">Individual</span>',
      organization: '<span class="badge b-blue">Organization</span>', aggregate: '<span class="badge b-gray">Unitemized total</span>',
      junk: '<span class="badge b-gray">Not a donor</span>' }[k] || '';
  }
  const isInkind = (s) => s === 'IIF' || s === 'IIG';
  const isCommittee = (f) => !['1', '3'].includes(String(f.filer_type || ''));   // committees sometimes lack a type code in the export
  const flagBadge = (c) => (c.flag === 'date_in_amount' ? ' <span class="badge b-gray" title="The amount field in this filing holds a date, so the real amount is unknown. Excluded from totals.">amount is a date</span>' : '');
  function sectionBadge(s) {
    return isInkind(s) ? '<span class="badge b-pink">In-kind</span>' : (s === 'IA' || s === 'IC') ? '<span class="badge b-purple">Committee cash</span>' : '<span class="badge b-blue">Cash</span>';
  }
  function officeText(f) {
    if (!f.office) return '';
    const o = label('office', f.office, f.office);
    return f.district && f.district !== '-1' && f.district !== '0' ? `${o}, District ${esc(f.district)}` : o;
  }
  function filerSub(f) {
    return [filerTypeBadge(f), partyBadge(f.party), esc(officeText(f)), esc(place(f.city, f.state))].filter(Boolean).join(' · ');
  }
  function donorHref(d) { return d.entity_id ? `/entity/${encodeURIComponent(d.entity_id)}` : `/donor/${d.donor_id}`; }
  // Intermediary committees in a money flow get a fixed hue each, in this order; any beyond the fourth share grey.
  const FLOW_COLORS = ['blue', 'pink', 'green', 'purple'];
  const flowColor = (i) => FLOW_COLORS[i] || 'gray';
  function flowBar(parts, max, colorOf) {
    // parts: [{id, total}], drawn left to right with a 2px gap; the whole bar is sized against max.
    const total = parts.reduce((t, p) => t + p.total, 0);
    if (!(total > 0)) return '';
    const width = Math.max(2, 100 * total / (max || total));
    return `<div class="fbar" style="width:${width}%" role="img" aria-label="${esc(parts.map((p) => `${colorOf.name(p.id)}: ${money(p.total)}`).join('; '))}">${parts.map((p) => `<i class="c-${colorOf.color(p.id)}" style="flex:${p.total} 0 0" title="${esc(colorOf.name(p.id))}: ${money(p.total)}"></i>`).join('')}</div>`;
  }
  function yearPills(years, current, base, extra = '') {
    const ys = years.map((y) => y.eyear ?? y);
    const shown = ys.length > 8 ? ys.slice(-8) : ys;
    return `<div class="pills">${shown.map((y) => `<a class="pill" href="${base}?year=${y}${extra}" data-link ${current === y ? 'aria-current="page"' : ''}>${y}</a>`).join('')}<a class="pill" href="${base}?year=all${extra}" data-link ${current === 'all' ? 'aria-current="page"' : ''}>All years</a></div>`;
  }
  function correctionLink(title, body) {
    const repo = META && META.repo_url;
    if (!repo) return '';
    const url = `${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    return `<a href="${esc(url)}" target="_blank" rel="noopener">Suggest a correction</a>`;
  }
  function searchResultsHtml(data, compact) {
    let h = '';
    if (data.filers.length) {
      h += '<div class="group">Recipients</div>';
      for (const f of data.filers) {
        h += `<a class="res" href="/filer/${encodeURIComponent(f.filer_id)}" data-link><span class="t"><span class="n">${esc(niceName(f.name))}</span><span class="s">${filerSub(f)}</span></span><span class="amt">${moneyShort(f.total_all)}</span></a>`;
      }
    }
    if (data.donors.length) {
      h += '<div class="group">Donors</div>';
      for (const d of data.donors) {
        const extra = [place(d.city, d.state), d.employer ? niceName(d.employer) : ''].filter(Boolean).join(' · ');
        h += `<a class="res" href="${donorHref(d)}" data-link><span class="t"><span class="n">${esc(niceName(d.name))}</span><span class="s">${kindBadge(d.kind)} ${esc(extra)}</span></span><span class="amt">${moneyShort(d.total_all)}</span></a>`;
      }
    }
    if (!h) h = `<div class="group" style="padding:12px 14px">No matches for “${esc(data.q)}”</div>`;
    if (compact) h += `<a class="more" href="/search?q=${encodeURIComponent(data.q)}" data-link>All results for “${esc(data.q)}” ↵</a>`;
    return h;
  }

  // ---- search box wiring --------------------------------------------------
  function wireSearch(form, input, dropdown) {
    let timer = null, last = '', active = -1;
    // Cancel the pending fetch too, or a late result reopens the dropdown after navigating.
    const close = () => { clearTimeout(timer); last = ''; dropdown.hidden = true; dropdown.innerHTML = ''; active = -1; };
    searchClosers.push(close);
    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { close(); return; }
      timer = setTimeout(async () => {
        last = q;
        try {
          const data = await api(`/search?q=${encodeURIComponent(q)}&limit=5`);
          if (q !== last) return;
          dropdown.innerHTML = searchResultsHtml(data, true);
          dropdown.hidden = false;
        } catch (e) { close(); }
      }, 140);
    });
    input.addEventListener('keydown', (e) => {
      const items = [...dropdown.querySelectorAll('a')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!items.length) return;
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((a, i) => a.classList.toggle('active', i === active));
      } else if (e.key === 'Enter' && active >= 0 && items[active]) {
        e.preventDefault(); navigate(items[active].getAttribute('href'));
      } else if (e.key === 'Escape') close();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      input.blur();
      if (q) navigate(`/search?q=${encodeURIComponent(q)}`);
    });
    document.addEventListener('click', (e) => { if (!form.contains(e.target)) close(); });
  }

  // ---- routing ------------------------------------------------------------
  const searchClosers = [];
  function closeSearch() {
    for (const c of searchClosers) c();
    for (const d of document.querySelectorAll('.dropdown')) { d.hidden = true; d.innerHTML = ''; }
    const nav = document.getElementById('nav-q');
    if (nav) nav.value = '';
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  function navigate(href) { closeSearch(); history.pushState(null, '', href); render(); }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault(); navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', () => { closeSearch(); render(); });

  async function render() {
    const url = new URL(location.href);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const q = url.searchParams;
    document.querySelectorAll('.nav-links a').forEach((a) => a.toggleAttribute('aria-current', a.getAttribute('href') === p));
    main.innerHTML = '<div class="loading">Loading…</div>';
    window.scrollTo(0, 0);
    try {
      if (!metaPromise) metaPromise = api('/meta').then((m) => { META = m; const fr = document.getElementById('footer-repo'); if (fr) { if (m.repo_url) fr.href = m.repo_url; else fr.remove(); } return m; });
      let m;
      if (p === '/') await home();
      else if (p === '/search') await searchPage(q.get('q') || '');
      else if (p === '/top') await topPage(q);
      else if (p === '/donors') await donorsPage(q);
      else if (p === '/about') { await metaPromise; aboutPage(); }
      else if ((m = p.match(/^\/filer\/([^/]+)$/))) await filerPage(decodeURIComponent(m[1]), q);
      else if ((m = p.match(/^\/donor\/(\d+)$/))) await donorPage(`/donor/${m[1]}`, q);
      else if ((m = p.match(/^\/entity\/([^/]+)$/))) await donorPage(`/entity/${m[1]}`, q);
      else main.innerHTML = '<h1>Not found</h1>';
      if (url.hash) { const el = document.getElementById(url.hash.slice(1)); if (el) el.scrollIntoView(); }
    } catch (e) {
      main.innerHTML = `<div class="card card-body"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p></div>`;
    }
  }

  // ---- pages ----------------------------------------------------------------
  async function home() {
    document.title = 'PA Money';
    const [top, donors] = await withMeta(Promise.all([api('/top?limit=10'), api('/top-donors?limit=5&kind=individual')]));
    const year = top.year;
    const c = META.counts || {};
    main.innerHTML = `
      <section class="hero">
        <h1>Who funds Pennsylvania politics?</h1>
        <p>Every contribution, expense and filer reported to the PA Department of State, searchable by who gave and who received.</p>
        <form class="hero-search" id="hero-search" role="search" action="/search" autocomplete="off">
          <label for="hero-q" class="sr-only">Search</label>
          <div class="box"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
            <input id="hero-q" name="q" type="search" placeholder="Search a candidate, committee, donor or employer"></div>
          <div class="dropdown" id="hero-dropdown" hidden></div>
        </form>
        <div class="chips">
          <a class="chip" href="/top?year=${year}" data-link>Top recipients, ${year}</a>
          <a class="chip" href="/donors?year=${year}" data-link>Biggest individual donors</a>
          <a class="chip" href="/top?year=${year}&type=committee" data-link>Biggest PACs and parties</a>
          <a class="chip" href="/about" data-link>How the data is cleaned</a>
        </div>
      </section>
      <section class="grid-2" style="margin-top:40px">
        <div class="card">
          <div class="card-head"><h2>Top recipients, ${year}</h2><a href="/top?year=${year}" data-link>Full ranking →</a></div>
          <div class="table-wrap"><table class="rows"><thead><tr><th style="width:36px">#</th><th>Recipient</th><th>Type</th><th class="num">Raised</th></tr></thead><tbody>
            ${top.rows.map((f, i) => `<tr><td class="muted m-hide">${i + 1}</td><td class="t"><a class="name" href="/filer/${encodeURIComponent(f.filer_id)}" data-link>${i + 1}. ${esc(niceName(f.name))}</a><div class="sub">${esc([officeText(f), place(f.city, f.state)].filter(Boolean).join(' · '))}<span class="m-only"> · ${filerTypeBadge(f)} ${partyBadge(f.party)}</span></div></td><td class="m-hide">${filerTypeBadge(f)} ${partyBadge(f.party)}</td><td class="num strong a">${moneyShort(f.total)}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="card-foot"><span>Totals count only the latest version of each report. Amended filings replace the originals.</span></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:16px">
          <div class="card">
            <div class="card-head"><h2>Biggest individual donors, ${year}</h2></div>
            <div class="table-wrap"><table class="rows"><tbody>
              ${donors.rows.map((d) => `<tr><td class="t"><a class="name" href="${donorHref(d)}" data-link>${esc(niceName(d.name))}</a><div class="sub">${esc(place(d.city, d.state))}${d.entity_id ? ' · merged' : ''}</div></td><td class="num strong a">${moneyShort(d.total)}</td></tr>`).join('')}
            </tbody></table></div>
            <div class="card-foot"><a href="/donors?year=${year}" data-link>All donors →</a></div>
          </div>
          <div class="card card-body" style="display:flex;flex-direction:column;gap:8px">
            <h2>About the data</h2>
            <dl style="margin:0;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:14px">
              <dt class="muted">Source</dt><dd style="margin:0">PA Department of State full export</dd>
              <dt class="muted">Years</dt><dd style="margin:0">${META.years ? `${META.years[0]} to ${META.years[META.years.length - 1]}` : ''}</dd>
              <dt class="muted">Built</dt><dd style="margin:0">${esc((META.built_at || '').slice(0, 10))}</dd>
              <dt class="muted">Records</dt><dd style="margin:0">${int(c.contribution)} contributions, ${int(c.expense)} expenses, ${int(c.filer)} filers</dd>
            </dl>
            <div class="row" style="margin-top:6px"><a class="btn" href="/about" data-link>Methodology</a>${META.repo_url ? `<a class="btn" href="${esc(META.repo_url)}" rel="noopener">Source &amp; corrections</a>` : ''}</div>
          </div>
        </div>
      </section>`;
    wireSearch(document.getElementById('hero-search'), document.getElementById('hero-q'), document.getElementById('hero-dropdown'));
    if (matchMedia('(pointer: fine)').matches) document.getElementById('hero-q').focus();
  }

  async function searchPage(q) {
    document.title = `“${q}” · PA Money`;
    const data = await withMeta(api(`/search?q=${encodeURIComponent(q)}&limit=50`));
    main.innerHTML = `
      <h1>Results for “${esc(q)}”</h1>
      <section class="grid-2">
        <div class="card"><div class="card-head"><h2>Recipients</h2><span class="muted small">${data.filers.length === 50 ? 'first 50' : data.filers.length} · ranked by money raised</span></div>
          <div class="table-wrap"><table class="rows"><tbody>${data.filers.map((f) => `<tr><td class="t"><a class="name" href="/filer/${encodeURIComponent(f.filer_id)}" data-link>${esc(niceName(f.name))}</a><div class="sub">${filerSub(f)}${f.first_year ? ` · ${f.first_year === f.last_year ? f.first_year : f.first_year + '–' + f.last_year}` : ''}</div></td><td class="num strong a">${moneyShort(f.total_all)}</td></tr>`).join('') || '<tr><td class="muted">None</td></tr>'}</tbody></table></div></div>
        <div class="card"><div class="card-head"><h2>Donors</h2><span class="muted small">${data.donors.length === 50 ? 'first 50' : data.donors.length} · ranked by money given</span></div>
          <div class="table-wrap"><table class="rows"><tbody>${data.donors.map((d) => `<tr><td class="t"><a class="name" href="${donorHref(d)}" data-link>${esc(niceName(d.name))}</a><div class="sub">${kindBadge(d.kind)} ${esc([place(d.city, d.state), d.employer ? niceName(d.employer) : ''].filter(Boolean).join(' · '))}</div></td><td class="num strong a">${moneyShort(d.total_all)}</td></tr>`).join('') || '<tr><td class="muted">None</td></tr>'}</tbody></table></div></div>
      </section>
      <p class="muted small">Search matches the start of words in names, cities and employers. Donors are listed under the name exactly as a committee filed it; spellings are combined only through reviewed corrections.</p>`;
  }

  async function topPage(q) {
    const type = q.get('type') || 'all';
    const offset = parseInt(q.get('offset') || '0', 10) || 0;
    const data = await withMeta(api(`/top?year=${encodeURIComponent(q.get('year') || '')}&type=${type}&limit=50&offset=${offset}`));
    const year = data.year;
    document.title = `Top recipients ${year} · PA Money`;
    const base = `/top`;
    const tq = `&type=${type}`;
    main.innerHTML = `
      <div class="page-head"><div class="title"><h1>Top recipients${year === 'all' ? ', all years' : ', ' + year}</h1><p class="muted">Ranked by contributions reported, latest version of each report.</p></div>
        <div class="tools">${yearPills(data.years, year, base, tq)}
          <div class="pills">${['all', 'candidate', 'committee'].map((t) => `<a class="pill" href="${base}?year=${year}&type=${t}" data-link ${type === t ? 'aria-current="page"' : ''}>${{ all: 'All filers', candidate: 'Candidates', committee: 'Committees' }[t]}</a>`).join('')}</div></div></div>
      <div class="card"><div class="table-wrap"><table class="rows"><thead><tr><th>#</th><th>Recipient</th><th>Type</th><th class="num">Raised</th><th class="num">In-kind</th><th class="num">Spent</th></tr></thead><tbody>
        ${data.rows.map((f, i) => `<tr><td class="muted m-hide">${offset + i + 1}</td><td class="t"><a class="name" href="/filer/${encodeURIComponent(f.filer_id)}" data-link><span class="m-only">${offset + i + 1}. </span>${esc(niceName(f.name))}</a><div class="sub">${esc([officeText(f), place(f.city, f.state)].filter(Boolean).join(' · '))}<span class="m-only"> · ${filerTypeBadge(f)} ${partyBadge(f.party)}${f.inkind ? ` · ${moneyShort(f.inkind)} in-kind` : ''} · spent ${moneyShort(f.expenses)}</span></div></td><td class="m-hide">${filerTypeBadge(f)} ${partyBadge(f.party)}</td><td class="num strong a">${money(f.total)}</td><td class="num muted m-hide">${f.inkind ? moneyShort(f.inkind) : ''}</td><td class="num muted m-hide">${moneyShort(f.expenses)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="card-foot"><span>Showing ${offset + 1}–${offset + data.rows.length}.${type === 'candidate' ? ' Most candidate money is raised by committees that file separately; linking a candidate to their committees is a reviewed correction, so this list understates candidates whose committees are not grouped yet.' : ''}</span><span class="pager">${offset > 0 ? `<a class="btn" href="${base}?year=${year}${tq}&offset=${Math.max(0, offset - 50)}" data-link>← Previous</a>` : ''}${data.rows.length === 50 ? `<a class="btn" href="${base}?year=${year}${tq}&offset=${offset + 50}" data-link>Next →</a>` : ''}</span></div></div>`;
  }

  async function donorsPage(q) {
    const kind = q.get('kind') || 'individual';
    const offset = parseInt(q.get('offset') || '0', 10) || 0;
    const data = await withMeta(api(`/top-donors?year=${encodeURIComponent(q.get('year') || '')}&kind=${kind}&limit=50&offset=${offset}`));
    const year = data.year;
    document.title = `Top donors ${year} · PA Money`;
    const base = '/donors';
    const kq = `&kind=${kind}`;
    main.innerHTML = `
      <div class="page-head"><div class="title"><h1>Biggest donors${year === 'all' ? ', all years' : ', ' + year}</h1><p class="muted">Each row is one name, city and state as filed. Spellings are combined only through reviewed corrections, so one person can appear more than once.</p></div>
        <div class="tools">${yearPills(data.years, year, base, kq)}
          <div class="pills">${['individual', 'organization', 'committee', 'all'].map((k) => `<a class="pill" href="${base}?year=${year}&kind=${k}" data-link ${kind === k ? 'aria-current="page"' : ''}>${{ individual: 'Individuals', organization: 'Organizations', committee: 'Committees', all: 'All' }[k]}</a>`).join('')}</div></div></div>
      <div class="card"><div class="table-wrap"><table class="rows"><thead><tr><th>#</th><th>Donor</th><th>Kind</th><th class="num">Recipients</th><th class="num">Gifts</th><th class="num">Total</th></tr></thead><tbody>
        ${data.rows.map((d, i) => `<tr><td class="muted m-hide">${offset + i + 1}</td><td class="t"><a class="name" href="${donorHref(d)}" data-link><span class="m-only">${offset + i + 1}. </span>${esc(niceName(d.name))}</a><div class="sub">${esc([place(d.city, d.state), d.employer ? niceName(d.employer) : ''].filter(Boolean).join(' · '))}${d.entity_id ? ` · <span class="badge b-gray">${d.n_keys > 1 ? d.n_keys + ' spellings merged' : 'merged'}</span>` : ''}<span class="m-only"> · ${kindBadge(d.kind)} · ${int(d.n)} gifts to ${int(d.n_recipients)}</span></div></td><td class="m-hide">${kindBadge(d.kind)}</td><td class="num m-hide">${int(d.n_recipients)}</td><td class="num m-hide">${int(d.n)}</td><td class="num strong a">${money(d.total)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="card-foot"><span>Showing ${offset + 1}–${offset + data.rows.length} of the top ${int(data.max || 1000)}. "Individual" is a heuristic: anything not filed as a political committee and without organization words in its name.</span><span class="pager">${offset > 0 ? `<a class="btn" href="${base}?year=${year}${kq}&offset=${Math.max(0, offset - 50)}" data-link>← Previous</a>` : ''}${data.rows.length === 50 && offset + 50 < (data.max || 1000) ? `<a class="btn" href="${base}?year=${year}${kq}&offset=${offset + 50}" data-link>Next →</a>` : ''}</span></div></div>`;
  }

  function barChart(timeline, year) {
    const max = Math.max(...timeline.map((t) => t.total), 1);
    const H = 150;
    const bars = timeline.map((t, i) => {
      const h = t.total > 0 ? Math.max(2, Math.round(H * t.total / max)) : 0;
      const name = year === 'all' ? t.label : t.label === 'other dates' ? 'Dated outside ' + year : MONTHS[parseInt(t.label.slice(5), 10) - 1] + ' ' + year;
      const showLab = t.total > 0 && t.total >= max * 0.25;
      return `<div class="bar" tabindex="0" aria-label="${esc(name)}: ${money(t.total)}">${showLab ? `<span class="lab">${moneyShort(t.total)}</span>` : ''}<i style="height:${h}px${t.total > 0 && t.total < max * 0.01 ? ';opacity:.45' : ''}"></i><span class="tip">${esc(name)}: ${money(t.total)}</span></div>`;
    }).join('');
    const axis = timeline.map((t) => `<span>${year === 'all' ? esc(t.label.slice(2)) : t.label === 'other dates' ? 'other' : MONTHS[parseInt(t.label.slice(5), 10) - 1]}</span>`).join('');
    return `<div class="bars" role="img" aria-label="Contributions over time">${bars}</div><div class="axis">${axis}</div>`;
  }

  function sourceChart(s) {
    const total = s.total || 0;
    const parts = [
      { k: 'inkind', c: 'pink', l: 'In-kind (Schedule II)', v: s.inkind },
      { k: 'committee', c: 'purple', l: 'Cash from committees (I-A, I-C)', v: s.cash_committee },
      { k: 'other', c: 'green', l: 'Cash from individuals and others (I-B, I-D)', v: s.cash_other },
    ];
    return `<div class="rows" role="img" aria-label="${parts.map((p) => `${p.l} ${fmtPct(pct(p.v, total))}`).join(', ')}">${parts.filter((p) => p.v > 0).map((p) => `<i class="c-${p.c}" style="flex:${p.v} 0 0" title="${esc(p.l)}: ${money(p.v)}"></i>`).join('')}</div>
      <ul class="legend">${parts.map((p) => `<li><span class="sw c-${p.c}"></span><span class="l">${esc(p.l)}</span><span class="strong">${moneyShort(p.v)}</span><span class="pct">${fmtPct(pct(p.v, total))}</span></li>`).join('')}</ul>`;
  }

  async function filerPage(id, q) {
    const combine = q.get('combine') !== '0';
    const data = await withMeta(api(`/filer/${encodeURIComponent(id)}?year=${encodeURIComponent(q.get('year') || '')}&combine=${combine ? 1 : 0}`));
    if (data.error) { main.innerHTML = `<h1>Filer not found</h1><p class="muted">No filer with ID ${esc(id)}.</p>`; return; }
    const f = data.filer, s = data.summary, year = data.year;
    const yearLabel = year === 'all' ? 'all years' : year;
    document.title = `${niceName(f.name)} · PA Money`;
    const base = `/filer/${encodeURIComponent(f.filer_id)}`;
    const cq = combine ? '' : '&combine=0';
    const yq = `year=${year}`;
    const groupName = data.group.length ? data.group[0].group_name : null;
    const others = data.group.filter((g) => g.filer_id !== f.filer_id);
    const entityById = Object.fromEntries((data.entities || []).map((e) => [e.entity_id, e]));
    const topDonor = data.top_donors[0];
    const topShare = topDonor ? pct(topDonor.total, s.total) : 0;
    const ad = data.as_donor || { links: [], recipients: [], total: 0, n_recipients: 0 };
    const linkSources = [...new Set(ad.links.map((l) => l.source))];
    const cycleLabel = (c) => label('cycle', String(c), `Cycle ${c}`);

    main.innerHTML = `
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/" data-link>Home</a><span>/</span><a href="/top" data-link>Recipients</a><span>/</span><span>${esc(niceName(f.name))}</span></nav>
      <div class="page-head">
        <div class="title">
          <div class="row">${filerTypeBadge(f)} ${partyBadge(f.party)} <span class="muted small">${esc([officeText(f), place(f.city, f.state), 'Filer ID ' + f.filer_id, f.first_year ? (f.first_year === f.last_year ? 'Filed ' + f.first_year : 'Filed ' + f.first_year + '–' + f.last_year) : ''].filter(Boolean).join(' · '))}</span></div>
          <h1>${esc(niceName(f.name))}</h1>
          ${data.group.length ? `<div class="notice"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h10M8 12h10M8 17h10M4 7h.01M4 12h.01M4 17h.01"/></svg><span style="flex:1">${combine ? `Showing <strong>${esc(groupName)}</strong> combined: ` : `Part of <strong>${esc(groupName)}</strong>, which also includes `}${others.map((g) => `<a href="/filer/${encodeURIComponent(g.filer_id)}?${yq}${cq}" data-link>${esc(niceName(g.name))}</a>`).join(', ')}. <a href="${base}?${yq}&combine=${combine ? 0 : 1}" data-link>${combine ? 'Show this filer alone' : 'Combine them'}</a> · ${correctionLink(`Filer group ${data.group[0].group_id}`, `Filer: ${f.filer_id} ${f.name}\nGroup: ${data.group[0].group_id} (${groupName})\n\nWhat is wrong with this grouping?`)}</span></div>` : ''}
        </div>
        <div class="tools">
          ${yearPills(data.years, year, base, cq)}
          <div class="row"><a class="btn" href="/api/filer/${encodeURIComponent(f.filer_id)}/contributions.csv?${yq}${cq}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M6 9l6 6 6-6M4 21h16"/></svg>Download CSV</a><a class="btn" href="#reports">Reports (${data.reports.length})</a></div>
        </div>
      </div>

      <section class="card kpis" aria-label="Summary">
        <div class="kpi"><div class="l">Raised, ${yearLabel}</div><div class="v">${moneyShort(s.total)}</div><div class="s">${int(s.n_contrib)} contributions</div></div>
        <div class="kpi"><div class="l">In-kind</div><div class="v">${moneyShort(s.inkind)}</div><div class="s">${fmtPct(pct(s.inkind, s.total))} of total</div></div>
        <div class="kpi"><div class="l">From committees</div><div class="v">${moneyShort(s.cash_committee)}</div><div class="s">${fmtPct(pct(s.cash_committee, s.total))} of total, cash</div></div>
        <div class="kpi"><div class="l">Distinct donors</div><div class="v">${int(s.n_donors)}</div><div class="s">${int(s.n_small)} gave $250 or less</div></div>
        <div class="kpi"><div class="l">Spent</div><div class="v">${moneyShort(s.expenses)}</div><div class="s">reported expenditures</div></div>
        ${ad.total > 0 ? `<div class="kpi"><div class="l">Gave to other committees</div><div class="v"><a href="#gave-to">${moneyShort(ad.total)}</a></div><div class="s">to ${int(ad.n_recipients)} recipient${ad.n_recipients == 1 ? '' : 's'}, as they reported</div></div>` : ''}
      </section>

      <section class="grid-2">
        <div class="card card-body" style="display:flex;flex-direction:column;gap:12px">
          <div class="row spread"><h2>${year === 'all' ? 'Contributions by year' : 'Contributions by month, ' + year}</h2><span class="muted small">Hover a bar for the exact total</span></div>
          ${barChart(data.timeline, year)}
          <p class="muted small">Dates are the contribution dates filers reported, not filing dates.</p>
        </div>
        <div class="card card-body" style="display:flex;flex-direction:column;gap:12px">
          <h2>Where the money came from</h2>
          ${sourceChart(s)}
          ${topDonor && topShare >= 25 ? `<div class="callout callout-pink"><strong>${esc(niceName(topDonor.name))} supplied ${fmtPct(topShare)} of this money.</strong> ${topDonor.inkind > 0 ? `${moneyShort(topDonor.inkind)} of it was in-kind. ` : ''}<a href="${topDonor.link_filer_id ? '/filer/' + encodeURIComponent(topDonor.link_filer_id) + '?year=' + year : topDonor.kind === 'committee' ? '/search?q=' + encodeURIComponent(topDonor.name) : donorHref(topDonor)}" data-link>${topDonor.link_filer_id ? 'Where did that committee’s money come from? →' : topDonor.kind === 'committee' ? 'Find that committee’s own filings →' : 'See everything they gave →'}</a></div>` : ''}
        </div>
      </section>

      <section class="card" id="donors">
        <div class="card-head"><h2>Top donors, ${yearLabel}</h2><span class="muted small">Grouped by name, city and state as filed</span></div>
        <div class="table-wrap"><table class="rows"><thead><tr><th>Donor</th><th>Kind</th><th class="num">Gifts</th><th class="num">Total</th><th>Share</th></tr></thead><tbody>
          ${data.top_donors.map((d) => `<tr><td class="t"><a class="name" href="${donorHref(d)}" data-link>${esc(niceName(d.name))}</a><div class="sub">${esc([place(d.city, d.state), d.employer ? niceName(d.employer) : ''].filter(Boolean).join(' · '))}${d.inkind > 0 ? ` · <span class="badge b-pink">${d.inkind >= d.total * 0.99 ? 'in-kind' : 'partly in-kind'}</span>` : ''}${d.entity_id ? ` · <span class="badge b-gray">${d.n_keys > 1 ? d.n_keys + ' spellings merged' : 'merged'}</span>` : ''}${d.link_filer_id ? ` · <a href="/filer/${encodeURIComponent(d.link_filer_id)}?year=${year}" data-link>its own filings →</a>` : ''}<span class="m-only"> · ${kindBadge(d.kind)} · ${int(d.n)} gift${d.n == 1 ? '' : 's'} · ${fmtPct(pct(d.total, s.total))} of total</span></div></td><td class="m-hide">${kindBadge(d.kind)}</td><td class="num m-hide">${int(d.n)}</td><td class="num strong a">${money(d.total)}</td><td class="m-hide"><div class="share"><i style="width:${Math.max(2, pct(d.total, s.total))}%"></i><span class="muted small">${fmtPct(pct(d.total, s.total))}</span></div></td></tr>`).join('') || '<tr><td class="muted" colspan="5">No contributions in this window.</td></tr>'}
        </tbody></table></div>
        <div class="card-foot"><span>${int(s.n_donors)} donors in total.</span><a href="#contributions">Browse every contribution ↓</a></div>
      </section>

      ${ad.links.length ? `<section class="card" id="gave-to">
        <div class="card-head"><h2>Where the money went, ${yearLabel}</h2><span class="muted small">Candidates and committees that reported receiving money from ${esc(niceName(f.name))}</span></div>
        <div class="table-wrap"><table class="rows"><thead><tr><th>Recipient</th><th>Type</th><th class="num">Gifts</th><th class="num">Total</th><th>Share</th></tr></thead><tbody>
          ${ad.recipients.map((r) => `<tr><td class="t"><a class="name" href="/filer/${encodeURIComponent(r.filer_id)}?year=${year}" data-link>${esc(niceName(r.name))}</a><div class="sub">${esc([officeText(r), place(r.city, r.state), year === 'all' && r.first_year ? (r.first_year === r.last_year ? r.first_year : r.first_year + '–' + r.last_year) : ''].filter(Boolean).join(' · '))}<span class="m-only"> · ${filerTypeBadge(r)} ${partyBadge(r.party)} · ${int(r.n)} gift${r.n == 1 ? '' : 's'} · ${fmtPct(pct(r.total, ad.total))}</span></div></td><td class="m-hide">${filerTypeBadge(r)} ${partyBadge(r.party)}</td><td class="num m-hide">${int(r.n)}</td><td class="num strong a">${money(r.total)}</td><td class="m-hide"><div class="share"><i style="width:${Math.max(2, pct(r.total, ad.total))}%"></i><span class="muted small">${fmtPct(pct(r.total, ad.total))}</span></div></td></tr>`).join('') || '<tr><td class="muted" colspan="5">No committee reported receiving money from this filer in this window.</td></tr>'}
        </tbody></table></div>
        <div class="card-foot"><span>${ad.n_recipients > ad.recipients.length ? `Top ${ad.recipients.length} of ${int(ad.n_recipients)} recipients. ` : ''}These are the recipients’ own reports, which can differ from the payments this committee itself reported under <a href="#payees">largest payees</a>. On their reports this committee is named ${ad.links.length === 1 ? 'as' : `${ad.links.length} ways:`} ${ad.links.slice(0, 6).map((l) => `<a href="/donor/${l.donor_id}?merged=0" data-link>${esc(l.name)}</a>${l.city ? ` <span class="muted">(${esc(place(l.city, l.state))})</span>` : ''}`).join(', ')}${ad.links.length > 6 ? ` and ${ad.links.length - 6} more` : ''}. ${linkSources.includes('name') ? 'Names were matched to this filer exactly as spelled; ' : 'Each name was linked to this filer by a reviewed rule; '}${correctionLink(`Committee link: ${f.name} (${f.filer_id})`, `Filer: ${f.filer_id} ${f.name}\nLinked donor keys:\n${ad.links.map((l) => l.donor_key).join('\n')}\n\nWhich link is wrong, or which spelling is missing, and what is the evidence?`) || 'see the cleanup rules to propose a change'}.</span></div>
      </section>` : ''}

      <section class="card" id="contributions">
        <div class="card-head"><h2>Contributions, ${yearLabel}</h2>
          <form class="row" id="contrib-filters">
            <label class="sr-only" for="cf-kind">Kind</label><select class="sel" id="cf-kind" name="kind"><option value="">Cash and in-kind</option><option value="cash">Cash only</option><option value="inkind">In-kind only</option><option value="committee">From committees</option><option value="other">From individuals and others</option></select>
            <label class="sr-only" for="cf-min">Minimum</label><select class="sel" id="cf-min" name="min"><option value="">Any amount</option><option value="250">Over $250</option><option value="1000">$1,000+</option><option value="10000">$10,000+</option><option value="100000">$100,000+</option></select>
            <label class="sr-only" for="cf-q">Filter</label><input class="sel" id="cf-q" name="q" type="search" placeholder="Name, employer, city or occupation" style="width:240px">
            <label class="sr-only" for="cf-sort">Sort</label><select class="sel" id="cf-sort" name="sort"><option value="amount">Largest first</option><option value="date">Newest first</option></select>
          </form></div>
        <div id="contrib-table"><div class="loading">Loading…</div></div>
      </section>

      <section class="grid-2">
        <div class="card">
          <div class="card-head" id="payees"><h2>Largest payees, ${yearLabel}</h2><a href="#" id="expenses-link">Browse expenses</a></div>
          <div class="table-wrap"><table class="rows"><thead><tr><th>Payee</th><th class="num">Payments</th><th class="num">Total</th></tr></thead><tbody>
            ${data.payees.map((p) => `<tr><td class="t"><span class="strong">${esc(niceName(p.payee))}</span><div class="sub">${esc(place(p.city, p.state))}<span class="m-only"> · ${int(p.n)} payment${p.n == 1 ? '' : 's'}</span></div></td><td class="num m-hide">${int(p.n)}</td><td class="num strong a">${money(p.total)}</td></tr>`).join('') || '<tr><td class="muted" colspan="3">No expenses in this window.</td></tr>'}
          </tbody></table></div>
          <div id="expense-table"></div>
        </div>
        <div class="card" id="reports">
          <div class="card-head"><h2>Reports filed, ${yearLabel}</h2></div>
          <div class="table-wrap"><table class="rows"><thead><tr><th>Period</th><th>Filed</th><th class="num">Receipts</th><th></th></tr></thead><tbody>
            ${data.reports.map((r) => { const flags = `${r.amend ? '<span class="badge b-blue">Amended</span>' : ''} ${r.terminate ? '<span class="badge b-gray">Termination</span>' : ''} ${r.is_current ? '' : '<span class="badge b-gray">Superseded</span>'}`; return `<tr${r.is_current ? '' : ' style="opacity:.55"'}><td class="t"><span class="strong">${esc(cycleLabel(r.cycle))}</span><div class="sub">${r.eyear}${data.ids.length > 1 ? ' · ' + esc(r.filer_id) : ''} · report ${r.cf_id}<span class="m-only"> · filed ${fmtDate(r.submitted)} ${flags}</span></div></td><td class="m-hide">${fmtDate(r.submitted)}</td><td class="num a">${money((r.monetary || 0) + (r.inkind || 0))}</td><td class="m-hide">${flags}</td></tr>`; }).join('') || '<tr><td class="muted" colspan="4">No reports.</td></tr>'}
          </tbody></table></div>
          <div class="card-foot"><span>Superseded reports were replaced by a later filing for the same period and are not counted.</span></div>
        </div>
      </section>`;

    const contribTable = document.getElementById('contrib-table');
    const filters = document.getElementById('contrib-filters');
    let offset = 0;
    async function loadContribs() {
      const fd = new FormData(filters);
      const qs = new URLSearchParams({ year, combine: combine ? 1 : 0, limit: 50, offset });
      for (const [k, v] of fd.entries()) if (v) qs.set(k, v);
      // Keep the current height while reloading so nothing below jumps under a finger mid-tap.
      contribTable.style.minHeight = contribTable.offsetHeight + 'px';
      contribTable.innerHTML = '<div class="loading">Loading…</div>';
      const d = await api(`/filer/${encodeURIComponent(f.filer_id)}/contributions?${qs}`);
      contribTable.style.minHeight = '';
      contribTable.innerHTML = `<div class="table-wrap"><table class="rows"><thead><tr><th>Date</th><th>Contributor</th><th>Kind</th><th class="num">Amount</th><th>Report</th></tr></thead><tbody>
        ${d.rows.map((c) => `<tr><td style="white-space:nowrap" class="m-hide">${fmtDate(c.date) || '<span class="muted">no date</span>'}</td><td class="t"><a class="name" href="${donorHref(c)}" data-link>${esc(niceName(c.contributor) || '(blank)')}</a><div class="sub">${esc([place(c.city, c.state), c.occupation ? niceName(c.occupation) : '', c.employer ? niceName(c.employer) : ''].filter(Boolean).join(' · '))}${c.description ? ` · <em>${esc(c.description)}</em>` : ''}<span class="m-only"> · ${fmtDate(c.date) || 'no date'} · ${sectionBadge(c.section)} · ${esc(cycleLabel(c.cycle))}</span></div></td><td class="m-hide">${sectionBadge(c.section)} <span class="muted small">${esc(c.section || '')}</span></td><td class="num strong a">${money(c.amount)}${flagBadge(c)}</td><td class="small muted m-hide">${esc(cycleLabel(c.cycle))}${data.ids.length > 1 ? '<br>' + esc(c.filer_id) : ''}</td></tr>`).join('') || '<tr><td class="muted" colspan="5">Nothing matches.</td></tr>'}
      </tbody></table></div>
      <div class="card-foot"><span>${int(d.count)} contributions totaling ${money(d.total)}. Showing ${d.count ? offset + 1 : 0}–${offset + d.rows.length}.</span><span class="pager"><button class="btn" id="cp" ${offset ? '' : 'disabled'}>← Previous</button><button class="btn" id="cn" ${offset + 50 < d.count ? '' : 'disabled'}>Next →</button></span></div>`;
      contribTable.querySelector('#cp').onclick = () => { offset = Math.max(0, offset - 50); loadContribs(); };
      contribTable.querySelector('#cn').onclick = () => { offset += 50; loadContribs(); };
    }
    // The text box reloads as you type (below); its blur-time change event must not reload again.
    filters.addEventListener('change', (e) => { if (e.target.id === 'cf-q') return; offset = 0; loadContribs(); });
    filters.addEventListener('submit', (e) => { e.preventDefault(); offset = 0; loadContribs(); });
    let t = null;
    filters.querySelector('#cf-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { offset = 0; loadContribs(); }, 250); });
    loadContribs();

    const expTable = document.getElementById('expense-table');
    document.getElementById('expenses-link').addEventListener('click', async (e) => {
      e.preventDefault();
      expTable.innerHTML = '<div class="loading">Loading…</div>';
      const d = await api(`/filer/${encodeURIComponent(f.filer_id)}/expenses?year=${year}&combine=${combine ? 1 : 0}&limit=100`);
      expTable.innerHTML = `<div class="card-head" style="border-top:1px solid var(--line-2)"><h3>Largest expenses</h3><span class="muted small">${int(d.count)} payments, ${money(d.total)}</span></div><div class="table-wrap"><table class="rows"><thead><tr><th>Date</th><th>Payee</th><th>Purpose</th><th class="num">Amount</th></tr></thead><tbody>
        ${d.rows.map((x) => `<tr><td style="white-space:nowrap" class="m-hide">${fmtDate(x.date)}</td><td class="t"><span class="strong">${esc(niceName(x.payee))}</span><div class="sub">${esc([place(x.city, x.state), x.description].filter(Boolean).join(' · '))}<span class="m-only"> · ${fmtDate(x.date)}</span></div></td><td class="small m-hide">${esc(x.description || '')}</td><td class="num strong a">${money(x.amount)}${flagBadge(x)}</td></tr>`).join('')}
      </tbody></table></div>`;
    });
  }

  async function donorPage(path, q) {
    const data = await withMeta(api(`${path}?year=${encodeURIComponent(q.get('year') || 'all')}`));
    if (data.error) { main.innerHTML = '<h1>Donor not found</h1>'; return; }
    const d = data.donor, s = data.summary, year = data.year, entity = data.entity;
    const name = entity ? entity.name : niceName(d.name);
    document.title = `${name} · PA Money`;
    const yearLabel = year === 'all' ? 'all years' : year;
    const base = entity ? `/entity/${encodeURIComponent(entity.entity_id)}` : `/donor/${d.donor_id}`;
    const kind = entity ? entity.kind : d.kind;
    const cities = [...new Set(data.members.map((m) => place(m.city, m.state)).filter(Boolean))];
    const employers = [...new Set(data.members.map((m) => m.employer && niceName(m.employer)).filter(Boolean))];
    const occupations = [...new Set(data.members.map((m) => m.occupation && niceName(m.occupation)).filter(Boolean))];
    const keyList = data.members.map((m) => m.donor_key).join('\n');
    const issueBody = `Donor key(s):\n${keyList}\n${entity ? `Entity: ${entity.entity_id} (${entity.name})\n` : ''}\nWhat should change, and what is the evidence?`;
    const cycleLabel = (c) => label('cycle', String(c), `Cycle ${c}`);
    const filers = data.filers || [];
    const onward = data.onward || { via: [], recipients: [] };
    const viaIndex = Object.fromEntries(onward.via.map((v, i) => [v.filer_id, i]));
    const viaColor = { color: (id) => flowColor(viaIndex[id]), name: (id) => { const v = onward.via[viaIndex[id]]; return v ? niceName(v.name) : ''; } };
    const onwardMax = Math.max(...onward.recipients.map((r) => r.total), 1);
    const firstCommittee = data.recipients.find(isCommittee);

    main.innerHTML = `
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/" data-link>Home</a><span>/</span><a href="/donors" data-link>Donors</a><span>/</span><span>${esc(name)}</span></nav>
      <div class="page-head">
        <div class="title">
          <div class="row">${kindBadge(kind)} <span class="muted small">${esc(cities.join(' · '))}</span></div>
          <h1>${esc(name)}</h1>
          ${employers.length || occupations.length ? `<p class="muted">${occupations.length ? 'Occupation as filed: ' + esc(occupations.join(', ')) + '. ' : ''}${employers.length ? 'Employer as filed: ' + esc(employers.join(', ')) + '. ' : ''}Both are whatever each recipient committee typed on its report.</p>` : ''}
          ${entity ? `<div class="notice"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7"/></svg><span style="flex:1">This page combines ${data.members.length} filed spellings under a reviewed correction: ${data.members.map((m) => `<a href="/donor/${m.donor_id}?merged=0&year=${year}" data-link>${esc(m.name)}</a> <span class="muted small">(${esc(place(m.city, m.state))})</span>`).join(', ')}. ${entity.note ? esc(entity.note) + '. ' : ''}${correctionLink(`Merge ${entity.entity_id}: ${entity.name}`, issueBody) || ''}</span></div>` :
          d.kind_source === 'heuristic' ? `<p class="muted small">Labeled “${d.kind}” by a name heuristic. ${correctionLink(`Reclassify donor: ${d.name}`, issueBody)}</p>` :
          `<p class="muted small">${correctionLink(`Correction for donor: ${d.name}`, issueBody)}</p>`}
          ${filers.map((f) => `<div class="notice notice-flow"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M14 6l6 6-6 6"/></svg><span style="flex:1">This committee files its own reports as <a href="/filer/${encodeURIComponent(f.filer_id)}?year=${year}" data-link><strong>${esc(niceName(f.name))}</strong></a> <span class="muted small">(filer ${esc(f.filer_id)}${f.first_year ? `, ${f.first_year}–${f.last_year}` : ''})</span>: raised ${moneyShort(f.total_all)}, spent ${moneyShort(f.expenses)}. <a href="/filer/${encodeURIComponent(f.filer_id)}?year=${year}#gave-to" data-link>See where its money came from and went →</a> <span class="muted small">${f.source === 'rule' ? 'Linked by a reviewed rule.' : 'Matched by exact name and state.'} ${correctionLink(`Committee link: ${d.name} → ${f.filer_id}`, `${issueBody}\n\nLinked to filer ${f.filer_id} (${f.name}).`)}</span></span></div>`).join('')}
        </div>
        <div class="tools">${yearPills(data.years, year, base)}</div>
      </div>

      <section class="card kpis" aria-label="Summary">
        <div class="kpi"><div class="l">Total given, ${yearLabel}</div><div class="v">${moneyShort(s.total)}</div><div class="s">${int(s.n)} contributions</div></div>
        <div class="kpi"><div class="l">Recipients</div><div class="v">${int(s.n_recipients)}</div><div class="s">${year === 'all' ? `${data.years[0] ? data.years[0].eyear : ''}–${data.years.length ? data.years[data.years.length - 1].eyear : ''}` : year}</div></div>
        <div class="kpi"><div class="l">Largest gift</div><div class="v">${s.largest ? moneyShort(s.largest.amount) : '—'}</div><div class="s">${s.largest ? esc(niceName(s.largest.filer_name)) + (s.largest.date ? ', ' + fmtDate(s.largest.date) : '') : ''}</div></div>
        ${s.rank ? `<div class="kpi"><div class="l">Rank among individuals</div><div class="v">#${int(s.rank)}</div><div class="s">by total given, ${yearLabel}</div></div>` : ''}
      </section>

      ${onward.via.length ? `<section class="card" id="flow">
        <div class="card-head"><h2>Follow the money, ${yearLabel}</h2><span class="muted small">Committees ${esc(name)} funded, and where those committees sent money</span></div>
        <div class="flow">
          <div class="flow-step">
            <div class="flow-title"><span class="flow-num">1</span><h3>${esc(name)} gave to ${onward.via.length === 1 ? 'this committee' : `these ${onward.via.length} committees`}</h3></div>
            <ul class="flow-via">${onward.via.map((v, i) => `<li><span class="sw c-${flowColor(i)}"></span><div class="t"><a class="name" href="/filer/${encodeURIComponent(v.filer_id)}?year=${year}" data-link>${esc(niceName(v.name))}</a><div class="sub">received <strong>${moneyShort(v.received)}</strong> from ${esc(name)} · passed on <strong>${moneyShort(v.passed_on)}</strong> to ${int(v.n_recipients)} recipient${v.n_recipients == 1 ? '' : 's'}</div></div></li>`).join('')}</ul>
            ${data.recipients.filter(isCommittee).length > onward.via.length ? `<p class="muted small">${onward.via.length === 8 ? `The ${onward.via.length} committees that received the most from ${esc(name)}, among those` : 'Only committees'} whose name appears as a donor on other reports${onward.via.length === 8 ? '' : ' can be followed further'}. <a href="#recipients">All recipients ↓</a></p>` : ''}
          </div>
          <div class="flow-step">
            <div class="flow-title"><span class="flow-num">2</span><h3>${onward.via.length === 1 ? 'That committee' : 'Those committees'} gave to</h3></div>
            <div class="table-wrap"><table class="rows flow-table"><tbody>
              ${onward.recipients.map((r) => `<tr><td class="t"><a class="name" href="/filer/${encodeURIComponent(r.filer_id)}?year=${year}" data-link>${esc(niceName(r.name))}</a><div class="sub">${[filerTypeBadge(r), partyBadge(r.party), esc(officeText(r)), esc(place(r.city, r.state))].filter(Boolean).join(' · ')}${r.via.length > 1 ? ` · via ${r.via.length} of them` : onward.via.length > 1 ? ` · via ${esc(viaColor.name(r.via[0].filer_id))}` : ''}</div>${flowBar(r.via.map((v) => ({ id: v.filer_id, total: v.total })), onwardMax, viaColor)}</td><td class="num strong a">${money(r.total)}</td></tr>`).join('')}
            </tbody></table></div>
            ${onward.n_recipients > onward.recipients.length ? `<p class="muted small">Top ${onward.recipients.length} of ${int(onward.n_recipients)} recipients${onward.truncated ? ' counted so far' : ''}. Each committee’s page lists all of them.</p>` : ''}
          </div>
        </div>
        <div class="card-foot"><span>Money is pooled: what a committee passed on came from all of its donors, not only ${esc(name)}, and in ${year === 'all' ? 'the same years' : year} only. Amounts are what each recipient reported receiving. A committee is matched to its own filings by exact name and state, or by a reviewed rule. <a href="/about#following" data-link>How this works</a></span></div>
      </section>` : ''}

      <section class="grid-2">
        <div style="display:flex;flex-direction:column;gap:20px">
          <div class="card" id="recipients"><div class="card-head"><h2>Recipients, ${yearLabel}</h2></div>
            <div class="table-wrap"><table class="rows"><thead><tr><th>Recipient</th><th>Type</th><th class="num">Gifts</th><th class="num">Total</th></tr></thead><tbody>
              ${data.recipients.map((f) => `<tr><td class="t"><a class="name" href="/filer/${encodeURIComponent(f.filer_id)}?year=${year}" data-link>${esc(niceName(f.name))}</a><div class="sub">${esc([officeText(f), place(f.city, f.state), year === 'all' && f.first_year ? (f.first_year === f.last_year ? f.first_year : f.first_year + '–' + f.last_year) : ''].filter(Boolean).join(' · '))}<span class="m-only"> · ${filerTypeBadge(f)} ${partyBadge(f.party)} · ${int(f.n)} gift${f.n == 1 ? '' : 's'}</span></div></td><td class="m-hide">${filerTypeBadge(f)} ${partyBadge(f.party)}</td><td class="num m-hide">${int(f.n)}</td><td class="num strong a">${money(f.total)}${f.inkind > 0 ? `<div class="sub">${moneyShort(f.inkind)} in-kind</div>` : ''}</td></tr>`).join('') || '<tr><td class="muted" colspan="4">Nothing in this window.</td></tr>'}
            </tbody></table></div></div>
          <div class="card"><div class="card-head"><h2>Every contribution, ${yearLabel}</h2><span class="muted small">${data.contributions.length === 200 ? 'largest 200' : data.contributions.length}</span></div>
            <div class="table-wrap"><table class="rows"><thead><tr><th>Date</th><th>Recipient</th><th>Filed as</th><th class="num">Amount</th><th>Report</th></tr></thead><tbody>
              ${data.contributions.map((c) => `<tr><td style="white-space:nowrap" class="m-hide">${fmtDate(c.date) || '<span class="muted">no date</span>'}</td><td class="t"><a class="name" href="/filer/${encodeURIComponent(c.filer_id)}?year=${c.eyear}" data-link>${esc(niceName(c.filer_name))}</a><div class="sub m-only">${fmtDate(c.date) || 'no date'} · filed as ${esc(c.contributor)}${c.employer ? ', ' + esc(c.employer) : ''} · ${esc(cycleLabel(c.cycle))} ${c.eyear}</div></td><td class="m-hide"><span>${esc(c.contributor)}</span><div class="sub">${esc([place(c.city, c.state), c.occupation, c.employer].filter(Boolean).join(' · '))}</div></td><td class="num strong a">${money(c.amount)} ${isInkind(c.section) ? '<span class="badge b-pink">in-kind</span>' : ''}${flagBadge(c)}</td><td class="small muted m-hide">${esc(cycleLabel(c.cycle))}<br>${c.eyear} · ${esc(label('section', c.section, c.section || 'unlabeled'))}</td></tr>`).join('')}
            </tbody></table></div></div>
        </div>
        <aside style="display:flex;flex-direction:column;gap:16px">
          ${!onward.via.length && firstCommittee ? `<div class="card card-body" style="display:flex;flex-direction:column;gap:10px"><h2>Keep following the money</h2><p class="small">${esc(niceName(firstCommittee.name))} is a committee, and committees pass money on. Its own filings list what it spent.</p><a class="btn btn-primary" href="/filer/${encodeURIComponent(firstCommittee.filer_id)}?year=${year}" data-link>What did ${esc(niceName(firstCommittee.name))} do with it? →</a></div>` : ''}
          ${employers.length ? `<div class="card card-body" style="display:flex;flex-direction:column;gap:8px"><h2>Same employer</h2><p class="small">Find other contributions where a committee listed ${employers.map((e) => `<a href="/search?q=${encodeURIComponent(e)}" data-link>${esc(e)}</a>`).join(' or ')} as the employer.</p></div>` : ''}
          <div class="card card-body" style="display:flex;flex-direction:column;gap:8px"><h2>Not in this data</h2><p class="small">Gifts to federal candidates and super PACs are filed with the FEC, not Pennsylvania. <a href="https://www.fec.gov/data/receipts/individual-contributions/?contributor_name=${encodeURIComponent(d.name)}" rel="noopener">Search this name on FEC.gov</a></p></div>
          <div class="card card-body" style="display:flex;flex-direction:column;gap:8px"><h2>Donor key${data.members.length > 1 ? 's' : ''}</h2>${data.members.map((m) => `<code class="small" style="word-break:break-all">${esc(m.donor_key)}</code>`).join('')}<p class="muted small">Used to propose a merge or reclassification in the cleanup files.</p></div>
        </aside>
      </section>`;
  }

  function aboutPage() {
    document.title = 'Data & corrections · PA Money';
    const repo = META.repo_url;
    const lk = META.lookups || {};
    const table = (kind, title) => `<h2>${title}</h2><div class="card table-wrap"><table><thead><tr><th>Code</th><th>Meaning</th><th>How we know</th></tr></thead><tbody>${Object.entries(lk[kind] || {}).map(([code, v]) => `<tr><td><code>${esc(code || '(blank)')}</code></td><td>${esc(v.label)}</td><td class="small muted">${esc(v.note || '')}</td></tr>`).join('')}</tbody></table></div>`;
    main.innerHTML = `
      <div class="prose">
        <h1>Data and corrections</h1>
        <p>PA Money is built from the <a href="${esc(META.source || '#')}" rel="noopener">full export</a> the Pennsylvania Department of State publishes, one ZIP per year since 2000. Nothing is scraped and nothing in a filing is edited. What you see is what committees reported, plus a small layer of reviewed corrections that anyone can inspect and propose changes to.</p>
        <h2>What counts</h2>
        <p>When a committee amends a report, the export contains both versions. We count only the latest report for each filer, year and period, and show superseded reports greyed out. Totals therefore differ from adding up every row in the raw files.</p>
        <h2>Who is a donor</h2>
        <p>The state assigns no IDs to donors. A donor here is a name, city and state exactly as filed, after uppercasing and removing punctuation. "Jeffrey Yass" in Bala Cynwyd and "Jeffery Yass" in Haverford are two donors until a reviewed rule says they are one person. <strong>Nothing is merged automatically.</strong> Merged pages say so and list every spelling they include.</p>
        <p>Whether a donor is a political committee comes from the form: Schedule I parts A and C are reserved for committees. Everything else is labeled individual or organization by a keyword heuristic, which the donor page discloses, or by an explicit rule.</p>
        <h2 id="following">Following money between committees</h2>
        <p>The state gives every filer an ID but gives donors none, so when a PAC appears as a contributor on another committee's report it is just a name. To follow money through a PAC, that name has to be tied to the PAC's own filer record. We do that in two ways, and each page says which applied: a <strong>reviewed rule</strong> in <code>cleanup/filer_links.csv</code>, or an <strong>exact match</strong> where the normalized name equals a name exactly one committee filer has used and the states agree. There is no fuzzy matching, and a rule can block an exact match that turns out to be wrong.</p>
        <p>"Follow the money" on a donor's page then shows two steps: the committees the donor gave to, and what those committees gave onward in the same years, as reported by the recipients. Money inside a committee is pooled, so the second step is what the committee did with all of its money, not with one donor's dollars in particular.</p>
        <h2>Proposing a correction</h2>
        <p>Every donor and filer page has a "Suggest a correction" link that opens a prefilled issue${repo ? ` in the <a href="${esc(repo)}" rel="noopener">public repository</a>` : ''}. Corrections live in plain CSV files with a reason and evidence for each row. A continuous check validates every proposed change, and a maintainer reviews merges of people before they go live, because a wrong merge attributes money to the wrong person.</p>
        ${repo ? `<p><a class="btn btn-primary" href="${esc(repo)}/blob/main/cleanup/README.md" rel="noopener">Read the correction rules</a></p>` : ''}
        <h2>Undocumented codes</h2>
        <p>The export's readme lists column names only. The labels below were worked out from form DSEB-502 and from filing dates in the data; each one says how confident we are. Corrections welcome.</p>
      </div>
      ${table('cycle', 'Reporting periods')}
      ${table('section', 'Schedule sections')}
      ${table('filer_type', 'Filer types')}
      ${table('office', 'Office codes')}
      ${table('party', 'Party codes')}
      <div class="prose"><h2>API</h2><p>Every page is backed by a JSON API you may use freely: <code>/api/search?q=</code>, <code>/api/filer/&lt;id&gt;?year=</code>, <code>/api/filer/&lt;id&gt;/contributions.csv?year=</code>, <code>/api/donor/&lt;id&gt;</code>, <code>/api/top?year=</code>, <code>/api/top-donors?year=</code>. Responses are cached for a few minutes.</p></div>`;
  }

  wireSearch(document.getElementById('nav-search'), document.getElementById('nav-q'), document.getElementById('nav-dropdown'));
  render();
})();
