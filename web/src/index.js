// PA Money API. One Cloudflare Worker: /api/* here, everything else from the static assets.

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };
const CACHE = 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400';  // edge copies expire within an hour of a data reload

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return pageWithSocialTags(request, env, url);
    // Workers responses are not cached at the edge unless we ask. Data changes only when the
    // database is reloaded, so cache every successful GET for a day keyed on the full URL.
    const cacheable = request.method === 'GET' && !url.searchParams.has('nocache');
    const cache = cacheable ? caches.default : null;
    if (cache) {
      const hit = await cache.match(request);
      if (hit) {
        const h = new Headers(hit.headers);
        h.set('x-pa-cache', 'hit');
        return new Response(hit.body, { status: hit.status, headers: h });
      }
    }
    try {
      const res = (await route(url, env)) || json({ error: 'not found' }, 404);
      if (cache && res.status === 200 && ctx) {
        res.headers.set('x-pa-cache', 'miss');
        ctx.waitUntil(cache.put(request, res.clone()));
      }
      return res;
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, 'cache-control': status === 200 ? CACHE : 'no-store', ...extra } });
}

async function route(url, env) {
  const p = url.pathname.replace(/\/+$/, '');
  const q = url.searchParams;
  let m;
  if (p === '/api/meta') return json(await meta(env));
  if (p === '/api/search') return json(await search(env, q.get('q') || '', num(q.get('limit'), 8, 50)));
  if (p === '/api/top') return json(await top(env, q));
  if (p === '/api/top-donors') return json(await topDonors(env, q));
  if ((m = p.match(/^\/api\/filer\/([^/]+)\/contributions\.csv$/))) return csvContributions(env, decodeURIComponent(m[1]), q);
  if ((m = p.match(/^\/api\/filer\/([^/]+)\/contributions$/))) return json(await filerContributions(env, decodeURIComponent(m[1]), q));
  if ((m = p.match(/^\/api\/filer\/([^/]+)\/expenses$/))) return json(await filerExpenses(env, decodeURIComponent(m[1]), q));
  if ((m = p.match(/^\/api\/filer\/([^/]+)$/))) return json(await filerPage(env, decodeURIComponent(m[1]), q));
  if ((m = p.match(/^\/api\/flow\/([^/]+)$/))) return json(await flowPage(env, decodeURIComponent(m[1]), q));
  if ((m = p.match(/^\/api\/donor\/(\d+)$/))) return json(await donorPage(env, Number(m[1]), q));
  if ((m = p.match(/^\/api\/entity\/([^/]+)$/))) return json(await entityPage(env, decodeURIComponent(m[1]), q));
  return null;
}

// ---- helpers ---------------------------------------------------------------

function num(v, dflt, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return dflt;
  return max ? Math.min(n, max) : n;
}

function ph(list) {
  return list.map(() => '?').join(',');
}

async function all(env, sql, params = []) {
  const r = await env.DB.prepare(sql).bind(...params).all();
  return r.results || [];
}

async function one(env, sql, params = []) {
  return env.DB.prepare(sql).bind(...params).first();
}

let lookupCache = null;
async function lookups(env) {
  if (lookupCache) return lookupCache;
  const rows = await all(env, 'SELECT kind, code, label, note FROM lookup');
  const out = {};
  for (const r of rows) {
    (out[r.kind] ||= {})[r.code] = { label: r.label, note: r.note };
  }
  lookupCache = out;
  return out;
}

async function meta(env) {
  const rows = await all(env, 'SELECT key, value FROM meta');
  const out = {};
  for (const r of rows) out[r.key] = JSON.parse(r.value);
  out.lookups = await lookups(env);
  out.repo_url = env.REPO_URL || null;
  return out;
}

// Turn free text into an FTS5 prefix query: "jeff yass" -> "jeff* yass*"
function ftsQuery(text) {
  const toks = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!toks.length) return null;
  return toks.map((t) => `"${t}"*`).join(' ');
}

// Resolve the year window. Returns { year: number|'all', clause, params }.
function yearWindow(q, years, col = 'eyear') {
  const raw = q.get('year');
  if (raw === 'all') return { year: 'all', clause: '', params: [] };
  let year = parseInt(raw, 10);
  if (!Number.isFinite(year)) {
    const withMoney = years.filter((y) => y.total > 0);
    year = (withMoney.length ? withMoney[withMoney.length - 1] : years[years.length - 1] || {}).eyear;
  }
  if (!year) return { year: 'all', clause: '', params: [] };
  return { year, clause: ` AND ${col} = ?`, params: [year] };
}

// ---- search ------------------------------------------------------------------

async function search(env, text, limit) {
  const match = ftsQuery(text);
  if (!match) return { q: text, filers: [], donors: [] };
  const filers = await all(env, `
    SELECT f.filer_id, f.name, f.filer_type, f.office, f.district, f.party, f.city, f.state, f.total_all, f.first_year, f.last_year, f.group_id
    FROM (SELECT DISTINCT filer_id FROM filer_fts WHERE filer_fts MATCH ?) s
    JOIN filer f ON f.filer_id = s.filer_id
    ORDER BY f.total_all DESC, f.last_year DESC LIMIT ?`, [match, limit]);
  // Spellings merged into one entity collapse into a single result carrying the entity's name and combined total.
  const donors = await all(env, `
    SELECT MIN(d.donor_id) donor_id, COALESCE(MAX(e.name), MIN(d.name)) name, MIN(d.city) city, MIN(d.state) state, MIN(d.employer) employer,
           MIN(d.occupation) occupation, COALESCE(MAX(e.kind), MIN(d.kind)) kind, d.entity_id, SUM(d.total_all) total_all, SUM(d.n_contrib) n_contrib,
           MIN(d.first_year) first_year, MAX(d.last_year) last_year, COUNT(*) n_keys
    FROM (SELECT DISTINCT donor_id FROM donor_fts WHERE donor_fts MATCH ?) s
    JOIN donor d ON d.donor_id = s.donor_id LEFT JOIN entity e ON e.entity_id = d.entity_id
    WHERE d.kind != 'aggregate'
    GROUP BY COALESCE(d.entity_id, 'd' || d.donor_id)
    ORDER BY total_all DESC LIMIT ?`, [match, limit]);
  return { q: text, filers, donors };
}

// ---- rankings ------------------------------------------------------------------

async function top(env, q) {
  const years = await all(env, 'SELECT eyear, SUM(total) total FROM filer_year GROUP BY eyear ORDER BY eyear');
  const w = yearWindow(q, years);
  const type = q.get('type') || 'all';
  const typeClause = type === 'candidate' ? " AND f.filer_type = '1'" : type === 'committee' ? " AND f.filer_type = '2'" : '';
  const limit = num(q.get('limit'), 25, 100);
  const offset = num(q.get('offset'), 0);
  const rows = await all(env, `
    SELECT f.filer_id, f.name, f.filer_type, f.office, f.district, f.party, f.city, f.state, f.group_id,
           SUM(y.total) total, SUM(y.inkind) inkind, SUM(y.n_contrib) n_contrib, SUM(y.expenses) expenses
    FROM filer_year y JOIN filer f ON f.filer_id = y.filer_id
    WHERE 1=1 ${w.clause.replace('eyear', 'y.eyear')} ${typeClause}
    GROUP BY f.filer_id ORDER BY total DESC LIMIT ? OFFSET ?`, [...w.params, limit, offset]);
  return { year: w.year, years: years.map((y) => y.eyear), type, rows, offset, limit };
}

async function topDonors(env, q) {
  // Rankings are precomputed at build time (pipeline/ranks.py): top 1000 per year and kind, entities collapsed.
  const years = await all(env, 'SELECT DISTINCT eyear FROM donor_rank WHERE eyear > 0 ORDER BY eyear');
  const w = yearWindow(q, years.map((y) => ({ eyear: y.eyear, total: 1 })));
  const kind = ['all', 'individual', 'organization', 'committee'].includes(q.get('kind')) ? q.get('kind') : 'individual';
  const limit = num(q.get('limit'), 25, 100);
  const offset = num(q.get('offset'), 0);
  const rows = await all(env, `
    SELECT donor_id, name, city, state, employer, donor_kind kind, entity_id, n_keys, total, n, n_recipients, rank
    FROM donor_rank WHERE eyear = ? AND kind = ? AND rank > ? ORDER BY rank LIMIT ?`,
    [w.year === 'all' ? 0 : w.year, kind, offset, limit]);
  return { year: w.year, years: years.map((y) => y.eyear), kind, rows, offset, limit, max: 1000 };
}

// ---- filer ---------------------------------------------------------------------

async function filerMembers(env, filer, q) {
  const combine = q.get('combine') !== '0';
  let group = [];
  if (filer.group_id) {
    group = await all(env, `
      SELECT f.filer_id, f.name, f.filer_type, f.office, f.district, f.party, f.city, f.state, f.total_all, f.first_year, f.last_year,
             g.group_name, g.reason
      FROM filer_group g JOIN filer f ON f.filer_id = g.filer_id WHERE g.group_id = ? ORDER BY f.total_all DESC`, [filer.group_id]);
  }
  const ids = combine && group.length ? group.map((g) => g.filer_id) : [filer.filer_id];
  return { combine, group, ids };
}

async function filerPage(env, id, q) {
  const filer = await one(env, 'SELECT * FROM filer WHERE filer_id = ?', [id]);
  if (!filer) return { error: 'not found' };
  const { combine, group, ids } = await filerMembers(env, filer, q);
  const years = await all(env, `SELECT eyear, SUM(total) total, SUM(expenses) expenses FROM filer_year WHERE filer_id IN (${ph(ids)}) GROUP BY eyear ORDER BY eyear`, ids);
  const w = yearWindow(q, years);
  const P = [...ids, ...w.params];

  const summaryQ = one(env, `
    SELECT COALESCE(SUM(total),0) total, COALESCE(SUM(cash_committee),0) cash_committee, COALESCE(SUM(cash_other),0) cash_other,
           COALESCE(SUM(inkind),0) inkind, COALESCE(SUM(n_contrib),0) n_contrib, COALESCE(SUM(expenses),0) expenses
    FROM filer_year WHERE filer_id IN (${ph(ids)}) ${w.clause}`, P);
  const donorsAggQ = one(env, `
    SELECT COUNT(*) n_donors, COALESCE(SUM(CASE WHEN t <= 250 THEN 1 ELSE 0 END),0) n_small
    FROM (SELECT donor_id, SUM(total) t FROM filer_donor_year WHERE filer_id IN (${ph(ids)}) ${w.clause} GROUP BY donor_id)`, P);
  const monthsQ = w.year === 'all' ? Promise.resolve([]) :
    all(env, `SELECT month, SUM(total) total FROM filer_month WHERE filer_id IN (${ph(ids)}) ${w.clause} GROUP BY month ORDER BY month`, P);
  const topDonorsQ = all(env, `
    SELECT MIN(d.donor_id) donor_id, COALESCE(MAX(e.name), MIN(d.name)) name, MIN(d.city) city, MIN(d.state) state, MIN(d.employer) employer,
           COALESCE(MAX(e.kind), MIN(d.kind)) kind, MIN(d.kind_source) kind_source, d.entity_id, COUNT(DISTINCT d.donor_id) n_keys,
           SUM(fd.total) total, SUM(fd.inkind) inkind, SUM(fd.n) n, MAX(l.filer_id) link_filer_id
    FROM filer_donor_year fd JOIN donor d ON d.donor_id = fd.donor_id LEFT JOIN entity e ON e.entity_id = d.entity_id
    LEFT JOIN filer_link l ON l.donor_id = d.donor_id
    WHERE fd.filer_id IN (${ph(ids)}) ${w.clause.replace('eyear', 'fd.eyear')}
    GROUP BY COALESCE(d.entity_id, 'd' || d.donor_id) ORDER BY total DESC LIMIT 15`, P);
  // This committee as a donor: the donor keys that are linked to it, and who reported receiving money from them.
  const linksQ = all(env, `
    SELECT d.donor_id, d.donor_key, d.name, d.city, d.state, d.total_all, d.entity_id, l.source, l.reason
    FROM filer_link l JOIN donor d ON d.donor_id = l.donor_id WHERE l.filer_id IN (${ph(ids)}) ORDER BY d.total_all DESC`, ids);
  const gaveToQ = all(env, `
    SELECT f.filer_id, f.name, f.filer_type, f.office, f.district, f.party, f.city, f.state, f.group_id,
           SUM(fd.total) total, SUM(fd.inkind) inkind, SUM(fd.n) n, MIN(fd.eyear) first_year, MAX(fd.eyear) last_year
    FROM filer_link l JOIN filer_donor_year fd ON fd.donor_id = l.donor_id JOIN filer f ON f.filer_id = fd.filer_id
    WHERE l.filer_id IN (${ph(ids)}) ${w.clause.replace('eyear', 'fd.eyear')}
    GROUP BY f.filer_id ORDER BY total DESC LIMIT 15`, P);
  const gaveAggQ = one(env, `
    SELECT COALESCE(SUM(fd.total),0) total, COUNT(DISTINCT fd.filer_id) n_recipients, COALESCE(SUM(fd.n),0) n
    FROM filer_link l JOIN filer_donor_year fd ON fd.donor_id = l.donor_id
    WHERE l.filer_id IN (${ph(ids)}) ${w.clause.replace('eyear', 'fd.eyear')}`, P);
  const largestQ = all(env, `
    SELECT c.id, c.cf_id, c.filer_id, c.eyear, c.cycle, c.section, c.donor_id, c.contributor, c.city, c.state, c.employer, c.occupation,
           c.date, c.amount, c.description, r.submitted, r.amend
    FROM contribution c LEFT JOIN report r ON r.cf_id = c.cf_id
    WHERE c.filer_id IN (${ph(ids)}) AND c.is_current = 1 AND c.flag IS NULL ${w.clause.replace('eyear', 'c.eyear')}
    ORDER BY c.amount DESC LIMIT 10`, P);
  const payeesQ = all(env, `
    SELECT payee, MIN(city) city, MIN(state) state, SUM(amount) total, COUNT(*) n
    FROM expense WHERE filer_id IN (${ph(ids)}) AND is_current = 1 AND flag IS NULL ${w.clause}
    GROUP BY UPPER(payee) ORDER BY total DESC LIMIT 10`, P);
  const reportsQ = all(env, `
    SELECT cf_id, filer_id, eyear, cycle, submitted, amend, terminate, beginning, monetary, inkind, is_current
    FROM report WHERE filer_id IN (${ph(ids)}) ${w.clause} ORDER BY eyear, cycle, submitted`, P);
  const [summary, donorsAgg, months, topDonorsRows, largest, payees, reports, links, gaveTo, gaveAgg, lk] =
    await Promise.all([summaryQ, donorsAggQ, monthsQ, topDonorsQ, largestQ, payeesQ, reportsQ, linksQ, gaveToQ, gaveAggQ, lookups(env)]);
  await annotateEndpoints(env, gaveTo, w);
  const trails = links.length ? await walkTrails(env, gaveTo, w, ids) : [];

  let timeline;
  if (w.year === 'all') {
    timeline = years.map((y) => ({ label: String(y.eyear), total: y.total }));
  } else {
    const byMonth = Object.fromEntries(months.map((m) => [m.month, m.total]));
    timeline = Array.from({ length: 12 }, (_, i) => {
      const key = `${w.year}-${String(i + 1).padStart(2, '0')}`;
      return { label: key, total: byMonth[key] || 0 };
    });
    // Contributions dated outside the election year (common on annual reports) are shown as one extra bucket.
    const outside = months.filter((m) => !m.month.startsWith(String(w.year))).reduce((s, m) => s + m.total, 0);
    if (outside > 0) timeline.push({ label: 'other dates', total: outside });
  }

  // Which donors above are part of a merged entity, so the UI can say so.
  const entityIds = [...new Set(topDonorsRows.map((d) => d.entity_id).filter(Boolean))];
  const entities = entityIds.length ? await all(env, `SELECT entity_id, name, kind FROM entity WHERE entity_id IN (${ph(entityIds)})`, entityIds) : [];

  return {
    filer, group, combine, ids, years, year: w.year,
    summary: { ...summary, ...donorsAgg },
    timeline, top_donors: topDonorsRows, largest, payees, reports, entities,
    as_donor: { links, recipients: gaveTo, trails, ...gaveAgg },
    lookups: lk,
  };
}

function contributionFilters(q) {
  const clauses = [];
  const params = [];
  const kind = q.get('kind');
  if (kind === 'inkind') clauses.push("c.section IN ('IIF','IIG')");
  if (kind === 'cash') clauses.push("(c.section IS NULL OR c.section NOT IN ('IIF','IIG'))");
  if (kind === 'committee') clauses.push("c.section IN ('IA','IC')");
  if (kind === 'other') clauses.push("(c.section IS NULL OR c.section IN ('IB','ID','IE'))");
  const min = parseFloat(q.get('min'));
  if (Number.isFinite(min)) { clauses.push('c.amount >= ?'); params.push(min); }
  const text = (q.get('q') || '').trim();
  if (text) {
    clauses.push('(c.contributor LIKE ? OR c.employer LIKE ? OR c.city LIKE ? OR c.occupation LIKE ?)');
    const like = `%${text}%`;
    params.push(like, like, like, like);
  }
  return { clause: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
}

async function filerContributions(env, id, q) {
  const filer = await one(env, 'SELECT filer_id, group_id FROM filer WHERE filer_id = ?', [id]);
  if (!filer) return { error: 'not found' };
  const { ids } = await filerMembers(env, filer, q);
  const years = await all(env, `SELECT eyear, SUM(total) total FROM filer_year WHERE filer_id IN (${ph(ids)}) GROUP BY eyear ORDER BY eyear`, ids);
  const w = yearWindow(q, years, 'c.eyear');
  const f = contributionFilters(q);
  const limit = num(q.get('limit'), 50, 200);
  const offset = num(q.get('offset'), 0);
  const sort = q.get('sort') === 'date' ? 'c.date DESC, c.amount DESC' : 'c.amount DESC, c.date DESC';
  const P = [...ids, ...w.params, ...f.params];
  const rows = await all(env, `
    SELECT c.id, c.cf_id, c.filer_id, c.eyear, c.cycle, c.section, c.donor_id, c.contributor, c.city, c.state, c.employer, c.occupation,
           c.date, c.amount, c.description, c.flag, d.entity_id
    FROM contribution c JOIN donor d ON d.donor_id = c.donor_id
    WHERE c.filer_id IN (${ph(ids)}) AND c.is_current = 1 ${w.clause} ${f.clause}
    ORDER BY ${sort} LIMIT ? OFFSET ?`, [...P, limit, offset]);
  const count = await one(env, `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN c.flag IS NULL THEN c.amount ELSE 0 END),0) total FROM contribution c WHERE c.filer_id IN (${ph(ids)}) AND c.is_current = 1 ${w.clause} ${f.clause}`, P);
  return { year: w.year, rows, offset, limit, count: count.n, total: count.total };
}

async function filerExpenses(env, id, q) {
  const filer = await one(env, 'SELECT filer_id, group_id FROM filer WHERE filer_id = ?', [id]);
  if (!filer) return { error: 'not found' };
  const { ids } = await filerMembers(env, filer, q);
  const years = await all(env, `SELECT eyear, SUM(expenses) total FROM filer_year WHERE filer_id IN (${ph(ids)}) GROUP BY eyear ORDER BY eyear`, ids);
  const w = yearWindow(q, years);
  const limit = num(q.get('limit'), 50, 200);
  const offset = num(q.get('offset'), 0);
  const text = (q.get('q') || '').trim();
  const tclause = text ? ' AND (payee LIKE ? OR description LIKE ? OR city LIKE ?)' : '';
  const tparams = text ? [`%${text}%`, `%${text}%`, `%${text}%`] : [];
  const P = [...ids, ...w.params, ...tparams];
  const rows = await all(env, `
    SELECT id, cf_id, filer_id, eyear, cycle, payee, city, state, date, amount, description, flag
    FROM expense WHERE filer_id IN (${ph(ids)}) AND is_current = 1 ${w.clause} ${tclause}
    ORDER BY amount DESC, date DESC LIMIT ? OFFSET ?`, [...P, limit, offset]);
  const count = await one(env, `SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN flag IS NULL THEN amount ELSE 0 END),0) total FROM expense WHERE filer_id IN (${ph(ids)}) AND is_current = 1 ${w.clause} ${tclause}`, P);
  return { year: w.year, rows, offset, limit, count: count.n, total: count.total };
}

async function csvContributions(env, id, q) {
  const filer = await one(env, 'SELECT filer_id, name, group_id FROM filer WHERE filer_id = ?', [id]);
  if (!filer) return json({ error: 'not found' }, 404);
  const { ids } = await filerMembers(env, filer, q);
  const years = await all(env, `SELECT eyear, SUM(total) total FROM filer_year WHERE filer_id IN (${ph(ids)}) GROUP BY eyear ORDER BY eyear`, ids);
  const w = yearWindow(q, years, 'c.eyear');
  const f = contributionFilters(q);
  const rows = await all(env, `
    SELECT c.filer_id, c.eyear, c.cycle, c.cf_id, c.section, c.contributor, c.city, c.state, c.zip, c.occupation, c.employer, c.date, c.amount, c.description, c.flag
    FROM contribution c WHERE c.filer_id IN (${ph(ids)}) AND c.is_current = 1 ${w.clause} ${f.clause}
    ORDER BY c.amount DESC LIMIT 20000`, [...ids, ...w.params, ...f.params]);
  const cols = ['filer_id', 'eyear', 'cycle', 'cf_id', 'section', 'contributor', 'city', 'state', 'zip', 'occupation', 'employer', 'date', 'amount', 'description', 'flag'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const body = [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n') + '\n';
  const name = `${filer.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${w.year}-contributions.csv`;
  return new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': CACHE } });
}

// ---- donor / entity ------------------------------------------------------------------

async function donorPage(env, donorId, q) {
  const donor = await one(env, 'SELECT * FROM donor WHERE donor_id = ?', [donorId]);
  if (!donor) return { error: 'not found' };
  if (donor.entity_id && q.get('merged') !== '0') return entityPage(env, donor.entity_id, q, donor);
  return donorView(env, [donor], null, q);
}

async function entityPage(env, entityId, q, focus = null) {
  const entity = await one(env, 'SELECT * FROM entity WHERE entity_id = ?', [entityId]);
  if (!entity) return { error: 'not found' };
  const members = await all(env, `
    SELECT d.*, de.reason, de.evidence, de.submitted_by FROM donor d JOIN donor_entity de ON de.donor_id = d.donor_id
    WHERE de.entity_id = ? ORDER BY d.total_all DESC`, [entityId]);
  return donorView(env, members, entity, q, focus);
}

async function donorView(env, members, entity, q, focus = null) {
  const ids = members.map((m) => m.donor_id);
  const years = await all(env, `SELECT eyear, SUM(total) total, SUM(n) n FROM donor_year WHERE donor_id IN (${ph(ids)}) GROUP BY eyear ORDER BY eyear`, ids);
  const w = yearWindow(q, years);
  const P = [...ids, ...w.params];
  const summaryQ = one(env, `
    SELECT COALESCE(SUM(total),0) total, COALESCE(SUM(n),0) n FROM donor_year WHERE donor_id IN (${ph(ids)}) ${w.clause}`, P);
  const recipientsQ = all(env, `
    SELECT f.filer_id, f.name, f.filer_type, f.office, f.district, f.party, f.city, f.state, f.group_id,
           SUM(fd.total) total, SUM(fd.inkind) inkind, SUM(fd.n) n, MIN(fd.eyear) first_year, MAX(fd.eyear) last_year
    FROM filer_donor_year fd JOIN filer f ON f.filer_id = fd.filer_id
    WHERE fd.donor_id IN (${ph(ids)}) ${w.clause.replace('eyear', 'fd.eyear')}
    GROUP BY f.filer_id ORDER BY total DESC LIMIT 100`, P);
  const contributionsQ = all(env, `
    SELECT c.id, c.cf_id, c.filer_id, f.name filer_name, c.eyear, c.cycle, c.section, c.donor_id, c.contributor, c.city, c.state,
           c.employer, c.occupation, c.date, c.amount, c.description, c.flag
    FROM contribution c JOIN filer f ON f.filer_id = c.filer_id
    WHERE c.donor_id IN (${ph(ids)}) AND c.is_current = 1 ${w.clause.replace('eyear', 'c.eyear')}
    ORDER BY c.amount DESC, c.date DESC LIMIT 200`, P);
  // If this donor is a committee that files its own reports, point at that filer record.
  const filersQ = all(env, `
    SELECT f.filer_id, f.name, f.filer_type, f.office, f.party, f.city, f.state, f.total_all, f.first_year, f.last_year, f.group_id,
           MIN(l.source) source, COUNT(*) n_keys,
           (SELECT COALESCE(SUM(expenses),0) FROM filer_year y WHERE y.filer_id = f.filer_id) expenses
    FROM filer_link l JOIN filer f ON f.filer_id = l.filer_id WHERE l.donor_id IN (${ph(ids)}) GROUP BY f.filer_id ORDER BY f.total_all DESC`, ids);
  const [summary, recipients, contributions, filers, lk] = await Promise.all([summaryQ, recipientsQ, contributionsQ, filersQ, lookups(env)]);
  const largest = contributions.find((c) => !c.flag) || null;
  const selfIds = filers.map((f) => f.filer_id);
  const [onward, trails] = await Promise.all([onwardFlows(env, recipients, w, selfIds), walkTrails(env, recipients, w, selfIds)]);
  let rank = null;
  if ((entity ? entity.kind : members[0].kind) === 'individual') {
    const r = await one(env, `SELECT MIN(rank) rank FROM donor_rank WHERE eyear = ? AND kind = 'individual' AND donor_id IN (${ph(ids)})`,
      [w.year === 'all' ? 0 : w.year, ...ids]);
    rank = r && r.rank;   // null when outside the top 1000
  }
  return {
    donor: focus || members[0], entity, members, ids, years, year: w.year,
    summary: { ...summary, n_recipients: recipients.length, largest, rank },
    recipients, contributions, filers, onward, trails, lookups: lk,
  };
}

// Second hop: for the committees this donor gave to that also appear as donors on other reports (filer_link),
// what did those committees pass on, in the same year window? Returns the intermediaries ("via") and the
// merged list of their recipients, so two PACs funding the same candidate show up as one row.
// Amounts are each recipient's own reports; a committee's onward giving includes money from all its donors.
async function onwardFlows(env, recipients, w, selfIds) {
  const VIA_MAX = 8, ROWS_MAX = 800;
  // Anything that is not a candidate's own record or a lobbyist is a committee; a few committees have no type code.
  const via = recipients.filter((r) => !['1', '3'].includes(String(r.filer_type || '')) && !selfIds.includes(r.filer_id)).slice(0, VIA_MAX);
  if (!via.length) return { via: [], recipients: [], total: 0, n_recipients: 0 };
  const viaIds = via.map((r) => r.filer_id);
  const P = [...viaIds, ...w.params];
  const linked = await all(env, `SELECT DISTINCT filer_id FROM filer_link WHERE filer_id IN (${ph(viaIds)})`, viaIds);
  if (!linked.length) return { via: [], recipients: [], total: 0, n_recipients: 0 };
  const [totals, rows] = await Promise.all([
    all(env, `
      SELECT l.filer_id via_id, COALESCE(SUM(fd.total),0) total, COUNT(DISTINCT fd.filer_id) n_recipients
      FROM filer_link l JOIN filer_donor_year fd ON fd.donor_id = l.donor_id
      WHERE l.filer_id IN (${ph(viaIds)}) ${w.clause.replace('eyear', 'fd.eyear')} GROUP BY l.filer_id`, P),
    all(env, `
      SELECT l.filer_id via_id, fd.filer_id, f.name, f.filer_type, f.office, f.district, f.party, f.city, f.state, SUM(fd.total) total, SUM(fd.n) n
      FROM filer_link l JOIN filer_donor_year fd ON fd.donor_id = l.donor_id JOIN filer f ON f.filer_id = fd.filer_id
      WHERE l.filer_id IN (${ph(viaIds)}) ${w.clause.replace('eyear', 'fd.eyear')}
      GROUP BY l.filer_id, fd.filer_id ORDER BY total DESC LIMIT ?`, [...P, ROWS_MAX]),
  ]);
  const totalBy = Object.fromEntries(totals.map((t) => [t.via_id, t]));
  const viaOut = via.filter((r) => totalBy[r.filer_id]).map((r) => ({
    filer_id: r.filer_id, name: r.name, city: r.city, state: r.state, received: r.total,
    passed_on: totalBy[r.filer_id].total, n_recipients: totalBy[r.filer_id].n_recipients,
  }));
  const merged = new Map();
  for (const r of rows) {
    let m = merged.get(r.filer_id);
    if (!m) {
      m = { filer_id: r.filer_id, name: r.name, filer_type: r.filer_type, office: r.office, district: r.district, party: r.party, city: r.city, state: r.state, total: 0, n: 0, via: [] };
      merged.set(r.filer_id, m);
    }
    m.total += r.total; m.n += r.n;
    m.via.push({ filer_id: r.via_id, total: r.total });
  }
  const list = [...merged.values()].sort((a, b) => b.total - a.total);
  await annotateEndpoints(env, list.slice(0, 15), w);
  return {
    via: viaOut,
    recipients: list.slice(0, 15),
    total: viaOut.reduce((s, v) => s + v.passed_on, 0),
    n_recipients: list.length,
    truncated: rows.length === ROWS_MAX,
  };
}


// ---- endpoints and trails ---------------------------------------------------------------
// A filer is an endpoint when money stops there: a candidate's own record, a committee with no filer_link
// (so it cannot be followed), or a committee that passed on less than a fifth of what it raised in the window.
// Everything else is a pass-through and can be expanded.
const PASS_SHARE = 0.2, PASS_MIN = 10000;
const isCandidateRecord = (f) => String(f.filer_type || '') === '1';

// D1 allows at most 100 bound parameters per statement, so long id lists are queried in chunks.
async function allChunked(env, ids, build, chunk = 90) {
  const out = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    const { sql, params } = build(part);
    out.push(...(await all(env, sql, params)));
  }
  return out;
}

async function flowStats(env, ids, w) {
  ids = [...new Set(ids)];
  if (!ids.length) return {};
  const yr = w.year === 'all' ? 0 : w.year;
  const flows = await allChunked(env, ids, (part) => ({ sql: `SELECT filer_id, passed_on, n_recipients FROM filer_flow WHERE eyear = ? AND filer_id IN (${ph(part)})`, params: [yr, ...part] }));
  const raised = w.year === 'all'
    ? await allChunked(env, ids, (part) => ({ sql: `SELECT filer_id, total_all total FROM filer WHERE filer_id IN (${ph(part)})`, params: part }))
    : await allChunked(env, ids, (part) => ({ sql: `SELECT filer_id, total FROM filer_year WHERE eyear = ? AND filer_id IN (${ph(part)})`, params: [w.year, ...part] }));
  const out = {};
  for (const r of raised) out[r.filer_id] = { raised: r.total, passed_on: 0, n_recipients: 0, linked: false };
  for (const f of flows) out[f.filer_id] = { ...(out[f.filer_id] || { raised: 0 }), passed_on: f.passed_on, n_recipients: f.n_recipients, linked: true };
  return out;
}

function classify(f, st) {
  if (isCandidateRecord(f)) return 'candidate';
  if (!st || !st.linked) return 'unlinked';
  if (st.passed_on < PASS_MIN || st.passed_on < PASS_SHARE * Math.max(st.raised || 0, 1)) return 'spends';
  return 'pass';
}

async function annotateEndpoints(env, rows, w) {
  const stats = await flowStats(env, rows.map((r) => r.filer_id), w);
  for (const r of rows) {
    const st = stats[r.filer_id];
    r.endpoint = classify(r, st);          // candidate | unlinked | spends | pass
    r.passed_on = st ? st.passed_on : 0;
    r.raised = st ? st.raised : null;
  }
  return stats;
}

// Breadth-first walk from a set of first-hop recipients through pass-through committees, at most MAX_HOPS deep.
// A trail is ranked by its weakest hop (the smallest amount along it), so a $2K gift to a party committee that
// then gave $11M to a candidate does not outrank a $98M gift that was passed on in full. For every endpoint the
// strongest trail is kept. Edges are followed when they are large in absolute terms, a meaningful share of the
// giver's outflow, or among the giver's top few; the same rule applies to the root's own gifts. No proportional
// attribution: each edge is the amount the recipient reported, and money inside a committee is pooled.
async function walkTrails(env, firstHop, w, selfIds = []) {
  const MAX_HOPS = 4, FRONTIER = 30, PER_VIA = 20, TOP_PER_VIA = 5, MIN_EDGE = 100000, MIN_SHARE = 0.05, OUT = 15;
  const direct = firstHop.filter((r) => !selfIds.includes(r.filer_id)).slice(0, 40);
  const rootOut = direct.reduce((t, r) => t + r.total, 0);
  const keep = (amount, outflow, i) => amount >= MIN_EDGE || amount >= MIN_SHARE * outflow || i < TOP_PER_VIA;
  const level0 = direct.filter((r, i) => keep(r.total, rootOut, i));
  if (!level0.length) return [];
  const stats = await annotateEndpoints(env, level0, w);
  const weakest = (path) => Math.min(...path.map((p) => p.amount));
  const best = new Map();        // endpoint id -> strongest trail
  const widest = new Map();      // pass-through id -> bottleneck of the strongest trail that reached it
  let frontier = [];
  // arrived: the earliest year money could have reached this node along the trail, i.e. the latest first-year upstream.
  const node = (r, amount, prev) => ({ filer_id: r.filer_id, name: r.name, filer_type: r.filer_type, office: r.office, district: r.district, party: r.party, city: r.city, state: r.state, amount, endpoint: r.endpoint, fy: r.first_year ?? null, ly: r.last_year ?? null, arrived: Math.max(prev ? prev.arrived : 0, r.first_year || 0) });
  for (const r of level0) {
    const path = [node(r, r.total, null)];
    if (r.endpoint === 'pass') { widest.set(r.filer_id, r.total); frontier.push({ id: r.filer_id, path, outflow: (stats[r.filer_id] || {}).passed_on || 0 }); }
    else best.set(r.filer_id, { path, hops: 1 });
  }
  for (let hop = 2; hop <= MAX_HOPS && frontier.length; hop++) {
    frontier.sort((a, b) => weakest(b.path) - weakest(a.path));
    frontier = frontier.slice(0, FRONTIER);
    const viaIds = frontier.map((f) => f.id);
    const rows = await all(env, `
      SELECT l.filer_id via_id, fd.filer_id, f.name, f.filer_type, f.office, f.district, f.party, f.city, f.state, SUM(fd.total) total,
             MIN(fd.eyear) first_year, MAX(fd.eyear) last_year
      FROM filer_link l JOIN filer_donor_year fd ON fd.donor_id = l.donor_id JOIN filer f ON f.filer_id = fd.filer_id
      WHERE l.filer_id IN (${ph(viaIds)}) ${w.clause.replace('eyear', 'fd.eyear')}
      GROUP BY l.filer_id, fd.filer_id ORDER BY total DESC LIMIT 1500`, [...viaIds, ...w.params]);
    const byVia = {};
    for (const r of rows) (byVia[r.via_id] ||= []).push(r);
    const dstIds = [...new Set(rows.map((r) => r.filer_id))];
    const dstStats = await flowStats(env, dstIds, w);
    const next = [];
    for (const fr of frontier) {
      const list = (byVia[fr.id] || []).slice(0, PER_VIA);
      const onPath = new Set(fr.path.map((p) => p.filer_id));
      const arrived = fr.path[fr.path.length - 1].arrived;   // money reached this giver no earlier than this year
      list.forEach((r, i) => {
        if (!keep(r.total, fr.outflow, i)) return;
        if (onPath.has(r.filer_id) || selfIds.includes(r.filer_id)) return;   // a loop back up this trail
        if (arrived && r.last_year != null && r.last_year < arrived) return;   // all given away before the money arrived
        r.endpoint = classify(r, dstStats[r.filer_id]);
        const path = [...fr.path, node(r, r.total, fr.path[fr.path.length - 1])];
        if (r.endpoint === 'pass') {
          // Re-expand a pass-through only when this trail reaches it with a wider bottleneck than any earlier one.
          const bn = weakest(path);
          if (!(widest.get(r.filer_id) >= bn)) { widest.set(r.filer_id, bn); next.push({ id: r.filer_id, path, outflow: (dstStats[r.filer_id] || {}).passed_on || 0 }); }
        } else {
          const cur = best.get(r.filer_id);
          if (!cur || weakest(cur.path) < weakest(path)) best.set(r.filer_id, { path, hops: path.length });
        }
      });
    }
    frontier = next;
  }
  return [...best.values()]
    .sort((a, b) => weakest(b.path) - weakest(a.path) || b.path[b.path.length - 1].amount - a.path[a.path.length - 1].amount)
    .slice(0, OUT)
    .map((t) => ({ hops: t.hops, endpoint: t.path[t.path.length - 1], amount: t.path[t.path.length - 1].amount, weakest: weakest(t.path), path: t.path }));
}

// One committee's onward recipients, for expanding a row in the follow-the-money view.
async function flowPage(env, id, q) {
  const filer = await one(env, 'SELECT filer_id, name, filer_type, total_all FROM filer WHERE filer_id = ?', [id]);
  if (!filer) return { error: 'not found' };
  const years = await all(env, 'SELECT eyear, passed_on total FROM filer_flow WHERE filer_id = ? AND eyear > 0 ORDER BY eyear', [id]);
  const w = yearWindow(q, years);
  const limit = num(q.get('limit'), 25, 100);
  const P = [id, ...w.params];
  const [rows, agg] = await Promise.all([
    all(env, `
      SELECT f.filer_id, f.name, f.filer_type, f.office, f.district, f.party, f.city, f.state, SUM(fd.total) total, SUM(fd.n) n
      FROM filer_link l JOIN filer_donor_year fd ON fd.donor_id = l.donor_id JOIN filer f ON f.filer_id = fd.filer_id
      WHERE l.filer_id = ? ${w.clause.replace('eyear', 'fd.eyear')} GROUP BY f.filer_id ORDER BY total DESC LIMIT ?`, [...P, limit]),
    one(env, `
      SELECT COALESCE(SUM(fd.total),0) total, COUNT(DISTINCT fd.filer_id) n_recipients
      FROM filer_link l JOIN filer_donor_year fd ON fd.donor_id = l.donor_id WHERE l.filer_id = ? ${w.clause.replace('eyear', 'fd.eyear')}`, P),
  ]);
  await annotateEndpoints(env, rows, w);
  return { filer, year: w.year, recipients: rows, ...agg };
}

// ---- social previews ----------------------------------------------------------------
// Crawlers do not run the app, so the HTML itself must carry the page's title, description and image.
// Everything else about the page still renders client-side.

const FALLBACK_IMAGE = { '/': 'home', filer: 'recipient', donor: 'donor', entity: 'donor', top: 'home', donors: 'donor', search: 'home', about: 'home' };

async function pageWithSocialTags(request, env, url) {
  const res = await env.ASSETS.fetch(request);
  const ct = res.headers.get('content-type') || '';
  if (request.method !== 'GET' || !ct.includes('text/html')) return res;
  let meta;
  try { meta = await socialMeta(env, url); } catch { meta = null; }
  if (!meta) meta = HOME_META;
  const origin = /^(localhost|127\.0\.0\.1)(:|$)/.test(url.host) ? url.origin : 'https://' + url.host;
  const image = meta.image.startsWith('http') ? meta.image : origin + meta.image;
  const canonical = origin + url.pathname + (meta.keepQuery ? url.search : '');
  const set = (prop, value) => ({ element(el) { el.setAttribute('content', value); } });
  const rewriter = new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(meta.title); } })
    .on('meta[name="description"]', set('content', meta.description))
    .on('meta[property="og:title"]', set('content', meta.title))
    .on('meta[property="og:description"]', set('content', meta.description))
    .on('meta[property="og:image"]', set('content', image))
    .on('meta[name="twitter:title"]', set('content', meta.title))
    .on('meta[name="twitter:description"]', set('content', meta.description))
    .on('meta[name="twitter:image"]', set('content', image))
    .on('head', { element(el) { el.append(`<meta property="og:url" content="${esc(canonical)}"><link rel="canonical" href="${esc(canonical)}">`, { html: true }); } });
  const out = rewriter.transform(res);
  return out;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const short = (n) => {
  n = Number(n) || 0;
  const a = Math.abs(n);
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
  return '$' + Math.round(n).toLocaleString('en-US');
};
const SMALL_WORDS = new Set(['of', 'for', 'and', 'the', 'to', 'at', 'in', 'on', 'by', 'a', 'an', 'or']);
const tc = (s) => (s && s === s.toUpperCase() && /[A-Z]/.test(s)
  ? s.toLowerCase().replace(/(^|[\s(\-/.])([a-z]+)/g, (m, p, w) => p + (SMALL_WORDS.has(w) && p !== '' ? w : w[0].toUpperCase() + w.slice(1))).replace(/\b(Pac|Llc|Ag|Da|Pa|Dc|Ny|Nj|Md|Us)\b/g, (w) => w.toUpperCase())
  : s);
const HOME_META = { title: 'PA Money', description: 'Who funds Pennsylvania politics? Every contribution, expense and filer reported to the PA Department of State, searchable by who gave and who received.', image: '/og/home.png', keepQuery: false };

async function socialMeta(env, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;
  let m;
  if ((m = p.match(/^\/filer\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    const f = await one(env, 'SELECT filer_id, name, office, party, city, state, total_all, first_year, last_year FROM filer WHERE filer_id = ?', [id]);
    if (!f) return null;
    const yearParam = q.get('year');
    const years = await all(env, 'SELECT eyear, total, inkind, n_contrib FROM filer_year WHERE filer_id = ? ORDER BY eyear', [id]);
    let y = years.length ? years[years.length - 1] : null;
    if (yearParam && yearParam !== 'all') y = years.find((r) => String(r.eyear) === yearParam) || y;
    const parts = [];
    if (yearParam === 'all' || !y) parts.push(`raised ${short(f.total_all)} since ${f.first_year}`);
    else parts.push(`raised ${short(y.total)} in ${y.eyear} from ${Number(y.n_contrib).toLocaleString('en-US')} contributions${y.inkind > 0 && y.total > 0 ? `, ${Math.round(100 * y.inkind / y.total)}% in-kind` : ''}`);
    await lookups(env);
    const where = [f.office ? label(env, 'office', f.office) : '', [tc(f.city), f.state].filter(Boolean).join(', ')].filter(Boolean);
    return { title: `${tc(f.name)} · PA Money`, description: `${tc(f.name)} ${parts.join(' ')}. ${where.length ? where.join(' · ') + '. ' : ''}Every donor and expense, from Pennsylvania's public filings.`, image: '/og/recipient.png', keepQuery: !!yearParam };
  }
  if ((m = p.match(/^\/(donor|entity)\/([^/]+)$/))) {
    const isEntity = m[1] === 'entity';
    const key = decodeURIComponent(m[2]);
    const d = isEntity
      ? await one(env, 'SELECT e.name, e.kind, SUM(d.total_all) total_all, MIN(d.first_year) first_year, MAX(d.last_year) last_year, COUNT(*) n_keys FROM entity e JOIN donor d ON d.entity_id = e.entity_id WHERE e.entity_id = ? GROUP BY e.entity_id', [key])
      : await one(env, 'SELECT name, kind, total_all, first_year, last_year, city, state, 1 n_keys FROM donor WHERE donor_id = ?', [Number(key)]);
    if (!d || !d.name) return null;
    const span = d.first_year && d.last_year ? (d.first_year === d.last_year ? `in ${d.first_year}` : `from ${d.first_year} to ${d.last_year}`) : '';
    return { title: `${tc(d.name)} · PA Money`, description: `${tc(d.name)} gave ${short(d.total_all)} to Pennsylvania candidates and committees ${span}.${d.n_keys > 1 ? ` Combines ${d.n_keys} filed spellings under a reviewed correction.` : ''} See every recipient.`, image: '/og/donor.png', keepQuery: false };
  }
  if (p === '/') return HOME_META;
  if (p === '/top') return { title: 'Top recipients · PA Money', description: 'Which Pennsylvania candidates and committees raised the most, by year, from the state\'s public campaign finance filings.', image: '/og/home.png', keepQuery: !!q.get('year') };
  if (p === '/donors') return { title: 'Biggest donors · PA Money', description: 'The biggest individual, organization and committee donors in Pennsylvania politics, by year.', image: '/og/donor.png', keepQuery: !!q.get('year') };
  if (p === '/search') { const s = q.get('q') || ''; return s ? { title: `“${s}” · PA Money`, description: `Pennsylvania campaign finance results for “${s}”: recipients and donors, ranked by money.`, image: '/og/home.png', keepQuery: true } : null; }
  if (p === '/about') return { title: 'Data & corrections · PA Money', description: 'How PA Money reads the state export, what it counts, and how anyone can propose a correction in the open.', image: '/og/home.png', keepQuery: false };
  return null;
}

function label(env, kind, code) {
  return (lookupCache && lookupCache[kind] && lookupCache[kind][code] && lookupCache[kind][code].label) || code;
}
