// scripts/lib/bulk-sources.js
//
// Masowe (bulk) pobieranie CALEJ bazy pakietow EndeavourOS (Arch core/extra/
// multilib + AUR) oraz danych porownawczych z Repology i Chocolatey - zamiast
// odpytywac kazdy pakiet osobno (co przy dziesiatkach tysiecy pakietow byloby
// zarowno wolne, jak i niegrzeczne wobec API), pobieramy z kazdego zrodla
// PELNA, paginowana liste za jednym przebiegiem:
//
//  - archlinux.org/packages/search/json/  - pelna lista core+extra+multilib
//    (ok. 15 500 pakietow, ~64 strony po 250, bez szczegolnego limitu).
//  - aur.archlinux.org/packages-meta-ext-v1.json.gz - JEDEN plik z metadanymi
//    WSZYSTKICH pakietow AUR (ok. 116 000).
//  - repology.org/api/v1/projects/?repo=arch  i  ?repo=aur - masowa,
//    paginowana (200/strone) lista projektow sledzonych przez Repology, w
//    ktorej KAZDY wpis od razu zawiera wersje we WSZYSTKICH innych sledzonych
//    dystrybucjach (Debian/Ubuntu/Fedora/openSUSE/Gentoo) - wiec ten sam
//    przebieg daje nam od razu porownanie miedzydystrybucyjne, bez osobnego
//    zapytania na pakiet. Wymaga max 1 zapytania/s (limit dla masowych
//    klientow Repology).
//  - community.chocolatey.org OData API - paginowana lista wszystkich
//    najnowszych wersji pakietow Chocolatey (ok. 9-10 tys.), zeby dopasowanie
//    "czy jest na Windows" bylo w pamieci (bez zapytania per pakiet).
//
// UWAGA: to biegnie WYLACZNIE w GitHub Actions (patrz build-full-data.js),
// nigdy w przegladarce - patrz komentarz architektoniczny w aggregate.js.

const zlib = require('zlib');

const APP_UA =
  'eos-pkg-checker/1.0 (+https://github.com/pwasiak30/endevour-package-checker)';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, opts = {}, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': APP_UA, ...opts.headers },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

// ---------- Arch Linux: pelna lista core+extra+multilib ----------
async function fetchAllArchPackages(log) {
  const map = new Map(); // pkgname -> row
  const repos = ['Core', 'Extra', 'Multilib'];
  for (const repo of repos) {
    let page = 1;
    let numPages = 1;
    do {
      const url = `https://archlinux.org/packages/search/json/?repo=${repo}&page=${page}`;
      const res = await fetchWithRetry(url);
      const data = await res.json();
      numPages = data.num_pages || 1;
      for (const r of data.results || []) {
        if (r.arch !== 'x86_64' && r.arch !== 'any') continue;
        map.set(r.pkgname, {
          repo: r.repo,
          pkgname: r.pkgname,
          version: `${r.epoch && r.epoch !== 0 ? r.epoch + ':' : ''}${r.pkgver}-${r.pkgrel}`,
          page_url: `https://archlinux.org/packages/${r.repo}/${r.arch}/${r.pkgname}/`,
          homepage: r.url || null,
          description: r.pkgdesc || null,
          licenses: r.licenses || [],
        });
      }
      if (log) log(`  arch ${repo}: strona ${page}/${numPages} (${map.size} razem)`);
      page++;
      await sleep(250); // uprzejma przerwa, ten endpoint nie ma formalnego limitu
    } while (page <= numPages);
  }
  return map;
}

// ---------- AUR: jeden zbiorczy dump metadanych ----------
async function fetchAllAurPackages(log) {
  const url = 'https://aur.archlinux.org/packages-meta-ext-v1.json.gz';
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/gzip' } });
  const buf = Buffer.from(await res.arrayBuffer());
  const json = zlib.gunzipSync(buf).toString('utf8');
  const arr = JSON.parse(json);
  const map = new Map();
  for (const r of arr) {
    if (!r.Name) continue;
    // przy zduplikowanych nazwach (nie powinno sie zdarzac) - zostaw nowszy PackageBase update
    const existing = map.get(r.Name);
    if (existing && (existing.LastModified || 0) >= (r.LastModified || 0)) continue;
    map.set(r.Name, {
      pkgname: r.Name,
      version: r.Version || null,
      page_url: `https://aur.archlinux.org/packages/${encodeURIComponent(r.Name)}`,
      homepage: r.URL || null,
      description: r.Description || null,
      licenses: r.License || [],
      LastModified: r.LastModified || 0,
    });
  }
  if (log) log(`  AUR: ${map.size} pakietow (z ${arr.length} wpisow w dumpie)`);
  return map;
}

// ---------- Repology: masowa, paginowana lista projektow ----------
// Zwraca Map<pkgname, entries[]> gdzie entries to SUROWE wpisy Repology dla
// calego projektu (wszystkie sledzone repozytoria naraz) - do dalszego
// przetworzenia przez bucketRepology() z aggregate.js. pkgname wyciagany jest
// z wpisow o repo === repoFilter (binname/srcname/visiblename) - jesli projekt
// ma kilka pakietow Arch/AUR (np. pakiety podzielone), wszystkie dostaja te
// sama liste porownawcza.
async function fetchRepologyBulkMap(repoFilter, log, opts = {}) {
  const map = new Map();
  let cursor = '';
  let pages = 0;
  const maxPages = opts.maxPages || Infinity; // tylko do lokalnych testow na probce
  for (;;) {
    const url = cursor
      ? `https://repology.org/api/v1/projects/${encodeURIComponent(cursor)}/?inrepo=${repoFilter}`
      : `https://repology.org/api/v1/projects/?inrepo=${repoFilter}`;
    const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } });
    const data = await res.json();
    const names = Object.keys(data);
    if (names.length === 0) break;

    // WAZNE: kolejnosc kluczy w odpowiedzi JSON NIE jest alfabetyczna (serwer
    // serializuje z hashmapy) - trzeba samemu posortowac, zeby wyliczyc
    // prawdziwie "najwyzsza" nazwe na tej stronie do uzycia jako kursor
    // nastepnej strony. Uzycie ostatniego klucza w kolejnosci z odpowiedzi
    // (bez sortowania) dawalo losowy, niepoprawny kursor i gubilo wiekszosc
    // pakietow.
    const sortedNames = names.slice().sort();

    for (const projectName of names) {
      if (projectName === cursor) continue; // paginacja jest inkluzywna - pomijamy powtorke
      const entries = data[projectName];
      const pkgnames = new Set();
      for (const e of entries) {
        if (e.repo === repoFilter) {
          const n = e.binname || e.srcname || e.visiblename;
          if (n) pkgnames.add(n);
        }
      }
      for (const n of pkgnames) map.set(n, entries);
    }

    pages++;
    const nextCursor = sortedNames[sortedNames.length - 1];
    if (log && pages % 10 === 0) log(`  repology (${repoFilter}): strona ${pages}, ${map.size} pakietow dotad, kursor="${nextCursor}"`);

    if (names.length < 200 || pages >= maxPages) break; // ostatnia strona
    cursor = nextCursor;
    await sleep(1050); // limit Repology: max 1 zapytanie/s dla masowych klientow
  }
  if (log) log(`  repology (${repoFilter}): gotowe, ${map.size} pakietow, ${pages} stron`);
  return map;
}

// ---------- Chocolatey: pelna lista najnowszych wersji ----------
function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseChocoEntry(entryXml) {
  const pick = (tag) => {
    const m = entryXml.match(new RegExp(`<d:${tag}[^>]*>([^<]*)</d:${tag}>`));
    return m ? decodeXmlEntities(m[1]) : null;
  };
  const idMatch = entryXml.match(/Packages\(Id='([^']+)',Version='([^']+)'\)/);
  const version = pick('Version');
  if (!version || !idMatch) return null;
  const id = idMatch[1];
  return {
    id,
    title: pick('Title') || id,
    version,
    description: pick('Summary') || pick('Description') || null,
    homepage: pick('ProjectUrl') || null,
    package_source_url: pick('PackageSourceUrl') || null,
    page_url: `https://community.chocolatey.org/packages/${id}`,
  };
}

async function fetchAllChocolateyPackages(log, opts = {}) {
  const map = new Map(); // normalizowane id -> row
  let skip = 0;
  const top = 100;
  const maxPages = opts.maxPages || Infinity;
  let pages = 0;
  for (;;) {
    const filter = encodeURIComponent('IsLatestVersion');
    const url = `https://community.chocolatey.org/api/v2/Packages()?$filter=${filter}&$orderby=Id&$skip=${skip}&$top=${top}`;
    const res = await fetchWithRetry(url, { headers: { Accept: 'application/atom+xml' } });
    const xml = await res.text();
    const parts = xml.split('<entry>').slice(1);
    if (parts.length === 0) break;
    for (const part of parts) {
      const row = parseChocoEntry(part);
      if (row) map.set(row.id.toLowerCase().replace(/[^a-z0-9]/g, ''), row);
    }
    pages++;
    if (log && pages % 10 === 0) log(`  chocolatey: strona ${pages}, ${map.size} pakietow dotad`);
    if (parts.length < top || pages >= maxPages) break;
    skip += top;
    await sleep(350);
  }
  if (log) log(`  chocolatey: gotowe, ${map.size} pakietow, ${pages} stron`);
  return map;
}

module.exports = {
  fetchAllArchPackages,
  fetchAllAurPackages,
  fetchRepologyBulkMap,
  fetchAllChocolateyPackages,
};
