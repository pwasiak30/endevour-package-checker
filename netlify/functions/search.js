// netlify/functions/search.js
//
// Serverless endpoint: GET /.netlify/functions/search?q=<nazwa_pakietu>
//
// Agreguje dane o wersjach pakietu z:
//  - Arch Linux official API (core/extra/multilib) -> baza repozytoriow EndeavourOS
//  - AUR RPC (Arch User Repository)
//  - wlasne repo "endeavouros" (best-effort, parsowanie pliku .db.tar.gz)
//  - Repology.org API -> Debian, Ubuntu, Fedora, openSUSE, Gentoo (wszystkie sledzone wersje)
//  - Linux Mint (best-effort scraping packages.linuxmint.com, z fallbackiem do bazy Ubuntu)
//
// Repology wymaga custom User-Agent i max. 1 zapytania/s dla bulk clients - ale tutaj
// odpytujemy Repology raz na wyszukiwanie, wiec limit nie jest problemem.

const APP_UA =
  'eos-pkg-checker/1.0 (+https://github.com/; kontakt przez issues repo)';

// Uwaga: male, wlasne repo "endeavouros" (pakiety eos-*, motywy) nie jest tu
// odpytywane - pliki .db na mirrorach EndeavourOS sa kompresowane XZ, co
// wymagaloby dodatkowej natywnej zaleznosci w funkcji serverless (ryzyko
// niestabilnego wdrozenia). To repo zawiera gl. narzedzia/branding EOS, wiec
// jego pominiecie nie wplywa na wyszukiwanie zwyklych pakietow (te sa w
// core/extra/multilib, ktore SA odpytywane ponizej).

// LTS release'y Ubuntu (parzyste .04 wydawane co 2 lata)
const UBUNTU_LTS = new Set([
  'ubuntu_14_04',
  'ubuntu_16_04',
  'ubuntu_18_04',
  'ubuntu_20_04',
  'ubuntu_22_04',
  'ubuntu_24_04',
  'ubuntu_26_04',
]);

// Aktualne (na moment pisania) kodowe nazwy Linux Mint -> Ubuntu base
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
      8000,
      'arch'
    );
    let results = (data.results || []).filter((r) => r.arch === 'x86_64' || r.arch === 'any');
    if (results.length === 0) {
      // fallback: szersze wyszukiwanie po q=, potem filtr na dokladna nazwe
      const data2 = await withTimeout(
        fetchJson(`https://archlinux.org/packages/search/json/?q=${encodeURIComponent(name)}`),
        8000,
        'arch-fallback'
      );
      results = (data2.results || []).filter((r) => r.pkgname === name);
    }
    return results.map((r) => ({
      repo: r.repo,
      pkgname: r.pkgname,
      version: `${r.epoch && r.epoch !== 0 ? r.epoch + ':' : ''}${r.pkgver}-${r.pkgrel}`,
      url: `https://archlinux.org/packages/${r.repo}/${r.arch}/${r.pkgname}/`,
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
      8000,
      'aur'
    );
    if (!data.results || data.results.length === 0) return null;
    const r = data.results[0];
    return {
      pkgname: r.Name,
      version: r.Version,
      url: `https://aur.archlinux.org/packages/${r.Name}`,
    };
  } catch (e) {
    return { error: e.message };
  }
}

// ---------- Repology (Debian / Ubuntu / Fedora / openSUSE / Gentoo) ----------
async function getRepologyData(name) {
  const attempt = async () =>
    withTimeout(
      fetchJson(`https://repology.org/api/v1/project/${encodeURIComponent(name)}`),
      15000,
      'repology'
    );
  try {
    const data = await attempt();
    return { ok: true, packages: Array.isArray(data) ? data : [] };
  } catch (e) {
    // pojedyncza proba ponowienia - repology bywa chwilowo przeciazone
    try {
      const data = await attempt();
      return { ok: true, packages: Array.isArray(data) ? data : [] };
    } catch (e2) {
      return { ok: false, error: e2.message, packages: [] };
    }
  }
}

// Minimalny comparator wersji (odpowiednik tego z frontendu) - uzywany tylko
// do wyboru "najnowszej" wersji sposrod wielu wpisow zwroconych przez Repology
// dla tego samego repo (Repology potrafi zwrocic kilka pakietow/binarek na
// jeden "projekt", np. firefox + firefox-esr + firefox-l10n).
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

function bucketRepology(packages) {
  // repo -> najlepszy (najnowszy) wpis dla tego repo
  const buckets = { debian: new Map(), ubuntu: new Map(), fedora: new Map(), opensuse: new Map(), gentoo: new Map() };

  for (const p of packages) {
    const repo = p.repo || '';
    const entry = {
      repo,
      version: p.version,
      origversion: p.origversion,
      status: p.status,
      name: p.visiblename || p.binname || p.srcname,
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
      const cmp = compareVersions(entry.version, existing.version);
      if (cmp > 0) {
        target.set(repo, entry);
      } else if (cmp === 0) {
        // remis wersji - preferuj "glowna" nazwe pakietu (bez -bin/-l10n/-esr itp. wariantow)
        const isVariant = (n) => /-(bin|l10n|dbg|debuginfo|debugsource)(\/|$)/i.test(n || '');
        if (isVariant(existing.name) && !isVariant(entry.name)) {
          target.set(repo, entry);
        }
      }
    }
  }

  return {
    debian: [...buckets.debian.values()],
    ubuntu: [...buckets.ubuntu.values()],
    fedora: [...buckets.fedora.values()],
    opensuse: [...buckets.opensuse.values()],
    gentoo: [...buckets.gentoo.values()],
  };
}

// ---------- Linux Mint (best-effort) ----------
async function getMintData(name, ubuntuBucket) {
  const results = [];
  for (const rel of MINT_RELEASES) {
    let scraped = null;
    try {
      const res = await withTimeout(
        fetch(
          `https://packages.linuxmint.com/list.php?release=${rel.codename}&search=${encodeURIComponent(
            name
          )}`,
          { headers: { 'User-Agent': 'Mozilla/5.0 eos-pkg-checker/1.0' } }
        ),
        6000,
        'mint'
      );
      if (res.ok) {
        const html = await res.text();
        // bardzo prosty scraping: szukamy wiersza tabeli z dokladna nazwa pakietu
        const rowRegex = new RegExp(
          `<tr>\\s*<td[^>]*>\\s*(?:<a[^>]*>)?\\s*${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*(?:</a>)?\\s*</td>[\\s\\S]{0,400}?</tr>`,
          'i'
        );
        const m = html.match(rowRegex);
        if (m) {
          const verMatch = m[0].match(/<td[^>]*>([\d][^<]*)<\/td>/);
          if (verMatch) scraped = verMatch[1].trim();
        }
      }
    } catch (e) {
      scraped = null;
    }

    if (scraped) {
      results.push({
        release: `Mint ${rel.version} "${rel.codename}"`,
        version: scraped,
        source: 'packages.linuxmint.com',
        estimated: false,
      });
    } else {
      // fallback: pokaz wersje z bazowego Ubuntu (Mint w wiekszosci dziedziczy pakiety z Ubuntu)
      const base = (ubuntuBucket || []).find((u) => u.repo === rel.base);
      results.push({
        release: `Mint ${rel.version} "${rel.codename}"`,
        version: base ? base.version : null,
        source: `estymacja z bazy ${rel.base.replace('ubuntu_', 'Ubuntu ').replace('_', '.')}`,
        estimated: true,
      });
    }
  }
  return results;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  };

  const name = (event.queryStringParameters && event.queryStringParameters.q || '').trim();
  if (!name) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Brak parametru q (nazwa pakietu)' }) };
  }
  if (!/^[a-zA-Z0-9+._-]{1,100}$/.test(name)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nieprawidlowa nazwa pakietu' }) };
  }

  const [archResult, aurResult, repologyResult] = await Promise.all([
    getArchPackages(name),
    getAurPackage(name),
    getRepologyData(name),
  ]);

  const buckets = bucketRepology(repologyResult.packages);
  const mint = await getMintData(name, buckets.ubuntu);

  const body = {
    query: name,
    endeavouros: {
      // EndeavourOS uzywa bezposrednio repozytoriow Arch (core/extra/multilib) + AUR.
      // (Male wlasne repo "endeavouros" z pakietami eos-*/motywami nie jest tu
      // uwzgledniane - patrz README.)
      arch_repos: Array.isArray(archResult) ? archResult : [],
      arch_error: Array.isArray(archResult) ? null : archResult.error,
      aur: aurResult && !aurResult.error ? aurResult : null,
      aur_error: aurResult && aurResult.error ? aurResult.error : null,
    },
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

  return { statusCode: 200, headers, body: JSON.stringify(body) };
};
