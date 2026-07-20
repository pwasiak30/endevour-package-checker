// scripts/lib/aggregate.js
//
// Logika agregacji danych o wersji pakietu z Arch Linux (core/extra/multilib),
// AUR i Repology (Debian/Ubuntu/Fedora/openSUSE/Gentoo) + estymacja Linux Mint.
//
// UWAGA ARCHITEKTONICZNA: ta logika biegnie WYLACZNIE po stronie serwera - w
// GitHub Actions (patrz scripts/build-data.js), NIGDY w przegladarce. Zaden z
// odpytywanych API (archlinux.org, aur.archlinux.org, repology.org) nie
// wysyla naglowka Access-Control-Allow-Origin, wiec wywolanie ich wprost z
// przegladarki (np. z GitHub Pages) zostaloby zablokowane przez CORS. Dlatego
// projekt jest w calosci statyczny: dane sa wyliczane raz na jakis czas przez
// GitHub Actions i zapisywane jako pliki JSON w docs/data/, ktore frontend
// czyta tak samo jak kazdy inny plik statyczny (bez CORS, bez backendu).

const APP_UA =
  'eos-pkg-checker/1.0 (+https://github.com/pwasiak30/endevour-package-checker)';

const UBUNTU_LTS = new Set([
  'ubuntu_14_04',
  'ubuntu_16_04',
  'ubuntu_18_04',
  'ubuntu_20_04',
  'ubuntu_22_04',
  'ubuntu_24_04',
  'ubuntu_26_04',
]);

const MINT_RELEASES = [
  { codename: 'zena', version: '22.3', base: 'ubuntu_24_04' },
  { codename: 'zara', version: '22.2', base: 'ubuntu_24_04' },
  { codename: 'xia', version: '22.1', base: 'ubuntu_24_04' },
  { codename: 'wilma', version: '22', base: 'ubuntu_24_04' },
];

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)
    ),
  ]);
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': APP_UA, Accept: 'application/json', ...opts.headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ---------- Arch Linux (core/extra/multilib) ----------
async function getArchPackages(name) {
  try {
    const data = await withTimeout(
      fetchJson(`https://archlinux.org/packages/search/json/?name=${encodeURIComponent(name)}`),
      15000,
      'arch'
    );
    let results = (data.results || []).filter((r) => r.arch === 'x86_64' || r.arch === 'any');
    if (results.length === 0) {
      const data2 = await withTimeout(
        fetchJson(`https://archlinux.org/packages/search/json/?q=${encodeURIComponent(name)}`),
        15000,
        'arch-fallback'
      );
      results = (data2.results || []).filter((r) => r.pkgname === name);
    }
    return results.map((r) => ({
      repo: r.repo,
      pkgname: r.pkgname,
      version: `${r.epoch && r.epoch !== 0 ? r.epoch + ':' : ''}${r.pkgver}-${r.pkgrel}`,
      page_url: `https://archlinux.org/packages/${r.repo}/${r.arch}/${r.pkgname}/`,
      homepage: r.url || null,
      description: r.pkgdesc || null,
      licenses: r.licenses || [],
    }));
  } catch (e) {
    return { error: e.message };
  }
}

// ---------- AUR ----------
async function getAurPackage(name) {
  try {
    const data = await withTimeout(
      fetchJson(`https://aur.archlinux.org/rpc/v5/info/${encodeURIComponent(name)}`),
      15000,
      'aur'
    );
    if (!data.results || data.results.length === 0) return null;
    const r = data.results[0];
    return {
      pkgname: r.Name,
      version: r.Version,
      page_url: `https://aur.archlinux.org/packages/${r.Name}`,
      homepage: r.URL || null,
      description: r.Description || null,
      licenses: r.License || [],
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------- Windows (Chocolatey community repository, dopasowanie po ID) ----------
// Best-effort: nie kazdy pakiet ma odpowiednik w Chocolatey, a nazwy ID czasem
// sie roznia od nazw pakietow linuksowych (np. wielkosc liter, myslniki) - w
// takim wypadku po prostu nie znajdziemy dopasowania i sekcja Windows zostanie
// pominieta (nie jest to blad).
function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

async function getWindowsPackage(name) {
  try {
    const filter = `(tolower(Id) eq '${name.toLowerCase().replace(/'/g, "''")}') and IsLatestVersion`;
    const url = `https://community.chocolatey.org/api/v2/Packages()?$filter=${encodeURIComponent(filter)}&$top=1`;
    const res = await withTimeout(
      fetch(url, { headers: { 'User-Agent': APP_UA, Accept: 'application/atom+xml' } }),
      15000,
      'chocolatey'
    );
    if (!res.ok) return null;
    const xml = await res.text();
    const entryParts = xml.split('<entry>');
    if (entryParts.length < 2) return null;
    const entry = entryParts[1];
    const pick = (tag) => {
      const m = entry.match(new RegExp(`<d:${tag}>([^<]*)</d:${tag}>`));
      return m ? decodeXmlEntities(m[1]) : null;
    };
    const idMatch = xml.match(/Packages\(Id='([^']+)',Version='([^']+)'\)/);
    const version = pick('Version');
    if (!version) return null;
    const id = idMatch ? idMatch[1] : name;
    return {
      id,
      title: pick('Title') || id,
      version,
      description: pick('Summary') || pick('Description') || null,
      homepage: pick('ProjectUrl') || null,
      package_source_url: pick('PackageSourceUrl') || null,
      page_url: `https://community.chocolatey.org/packages/${id}`,
    };
  } catch (e) {
    return null;
  }
}

// ---------- Repology (Debian / Ubuntu / Fedora / openSUSE / Gentoo) ----------
function normalizeVersion(v) {
  if (!v) return [];
  let s = String(v).replace(/^\d+:/, '');
  s = s.split(/[+~]/)[0];
  return s.split(/[.\-_]/).filter(Boolean).map((p) => {
    const n = parseInt(p, 10);
    return Number.isNaN(n) ? p : n;
  });
}
function compareVersions(a, b) {
  const pa = normalizeVersion(a);
  const pb = normalizeVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else {
      const sx = String(x), sy = String(y);
      if (sx !== sy) return sx < sy ? -1 : 1;
    }
  }
  return 0;
}

async function getRepologyData(name) {
  const attempt = async () =>
    withTimeout(
      fetchJson(`https://repology.org/api/v1/project/${encodeURIComponent(name)}`),
      20000,
      'repology'
    );
  try {
    const data = await attempt();
    return { ok: true, packages: Array.isArray(data) ? data : [] };
  } catch (e) {
    try {
      // repology bywa chwilowo przeciazone - jedna proba ponowienia
      await new Promise((r) => setTimeout(r, 2000));
      const data = await attempt();
      return { ok: true, packages: Array.isArray(data) ? data : [] };
    } catch (e2) {
      return { ok: false, error: e2.message, packages: [] };
    }
  }
}

// Gentoo (i inne repo oparte na ebuildach) czesto ma rownolegle "live" ebuildy
// oznaczone wersja "9999" (ciagna z HEAD gita, nie z wydania) - Repology
// oznacza je statusem "rolling". Numerycznie "9999" wygrywa z kazda realna
// wersja (np. "6.12.5"), wiec bez tego wyjatku apka pokazywalaby bez sensu
// "9999" jako "najnowsza wersje" niemal kazdego pakietu w Gentoo.
function isLiveEbuild(entry) {
  return entry.status === 'rolling' || entry.version === '9999';
}

// Repology sam oznacza niektore wpisy jako niewiarygodne (np. bledne
// dopasowanie projektu, jak "dev-util/xxd" podpiete pod projekt "vim") -
// takie wpisy pomijamy calkowicie, zamiast ryzykowac pokazanie zlych danych.
const UNTRUSTED_STATUSES = new Set(['incorrect', 'untrusted', 'ignored']);

// Stabilne, wersjo-niezalezne linki do strony/trackera pakietu w danej
// dystrybucji (nie wymagaja zgadywania nazwy kodowej wydania).
const PROJECT_LINK = {
  debian: (n) => `https://tracker.debian.org/pkg/${encodeURIComponent(n)}`,
  ubuntu: (n) => `https://launchpad.net/ubuntu/+source/${encodeURIComponent(n)}`,
  fedora: (n) => `https://src.fedoraproject.org/rpms/${encodeURIComponent(n)}`,
  opensuse: (n) => `https://software.opensuse.org/package/${encodeURIComponent(n)}`,
  gentoo: (n) => `https://packages.gentoo.org/packages/${n}`, // n to juz "kategoria/nazwa"
};

function bucketRepology(packages) {
  const buckets = { debian: new Map(), ubuntu: new Map(), fedora: new Map(), opensuse: new Map(), gentoo: new Map() };

  for (const p of packages) {
    if (UNTRUSTED_STATUSES.has(p.status)) continue;
    const repo = p.repo || '';
    const entry = {
      repo,
      version: p.version,
      origversion: p.origversion,
      status: p.status,
      name: p.visiblename || p.binname || p.srcname,
      srcname: p.srcname || p.binname || p.visiblename || null,
      summary: p.summary || null,
      licenses: p.licenses || [],
      vulnerable: !!p.vulnerable,
    };

    let target = null;
    if (repo.startsWith('debian_')) target = buckets.debian;
    else if (repo.startsWith('ubuntu_')) {
      entry.lts = UBUNTU_LTS.has(repo);
      target = buckets.ubuntu;
    } else if (repo.startsWith('fedora_')) target = buckets.fedora;
    else if (repo === 'opensuse_tumbleweed' || repo.startsWith('opensuse_leap_')) target = buckets.opensuse;
    else if (repo === 'gentoo') target = buckets.gentoo;
    if (!target) continue;

    const existing = target.get(repo);
    if (!existing) {
      target.set(repo, entry);
    } else {
      const existingLive = isLiveEbuild(existing);
      const entryLive = isLiveEbuild(entry);
      if (existingLive && !entryLive) {
        // realna wersja zawsze wygrywa z live/9999, niezaleznie od "wartosci" liczbowej
        target.set(repo, entry);
      } else if (existingLive === entryLive) {
        const cmp = compareVersions(entry.version, existing.version);
        if (cmp > 0) {
          target.set(repo, entry);
        } else if (cmp === 0) {
          const isVariant = (n) => /-(bin|l10n|dbg|debuginfo|debugsource)(\/|$)/i.test(n || '');
          if (isVariant(existing.name) && !isVariant(entry.name)) {
            target.set(repo, entry);
          }
        }
      }
      // else: existing jest realna wersja, entry jest live -> zostawiamy existing
    }
  }

  const result = {
    debian: [...buckets.debian.values()],
    ubuntu: [...buckets.ubuntu.values()],
    fedora: [...buckets.fedora.values()],
    opensuse: [...buckets.opensuse.values()],
    gentoo: [...buckets.gentoo.values()],
  };
  // stabilny link do projektu w kazdej dystrybucji (nie zalezy od konkretnego wydania)
  for (const [key, rows] of Object.entries(result)) {
    const linkFn = PROJECT_LINK[key];
    if (!linkFn) continue;
    for (const row of rows) {
      const ident = row.srcname || row.name;
      if (ident) row.project_link = linkFn(ident);
    }
  }
  return result;
}

// ---------- Linux Mint (estymacja z bazy Ubuntu - bez dodatkowych zapytan) ----------
function getMintData(ubuntuBucket) {
  return MINT_RELEASES.map((rel) => {
    const base = (ubuntuBucket || []).find((u) => u.repo === rel.base);
    return {
      release: `Mint ${rel.version} "${rel.codename}"`,
      version: base ? base.version : null,
      source: `estymacja z bazy ${rel.base.replace('ubuntu_', 'Ubuntu ').replace('_', '.')}`,
      estimated: true,
    };
  });
}

async function aggregatePackage(name) {
  const [archResult, aurResult, repologyResult, windowsResult] = await Promise.all([
    getArchPackages(name),
    getAurPackage(name),
    getRepologyData(name),
    getWindowsPackage(name),
  ]);

  const buckets = bucketRepology(repologyResult.packages);
  const mint = getMintData(buckets.ubuntu);

  let referenceVersion = null;
  const archRows = Array.isArray(archResult) ? archResult : [];
  for (const r of archRows) {
    if (!referenceVersion || compareVersions(r.version, referenceVersion) > 0) referenceVersion = r.version;
  }
  if (!referenceVersion && aurResult && !aurResult.error) referenceVersion = aurResult.version;

  return {
    query: name,
    repology_project_url: `https://repology.org/project/${encodeURIComponent(name)}/versions`,
    endeavouros: {
      arch_repos: archRows,
      arch_error: Array.isArray(archResult) ? null : archResult.error,
      aur: aurResult && !aurResult.error ? aurResult : null,
      aur_error: aurResult && aurResult.error ? aurResult.error : null,
    },
    windows: windowsResult,
    reference_version: referenceVersion,
    debian: buckets.debian,
    ubuntu: buckets.ubuntu,
    fedora: buckets.fedora,
    opensuse: buckets.opensuse,
    gentoo: buckets.gentoo,
    mint,
    repology_ok: repologyResult.ok,
    repology_error: repologyResult.ok ? null : repologyResult.error,
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  aggregatePackage,
  compareVersions,
  bucketRepology,
  getArchPackages,
  getAurPackage,
  getRepologyData,
  getWindowsPackage,
  getMintData,
  MINT_RELEASES,
  UBUNTU_LTS,
};
