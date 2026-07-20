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
      15000,
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

function bucketRepology(packages) {
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
  const [archResult, aurResult, repologyResult] = await Promise.all([
    getArchPackages(name),
    getAurPackage(name),
    getRepologyData(name),
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
    endeavouros: {
      arch_repos: archRows,
      arch_error: Array.isArray(archResult) ? null : archResult.error,
      aur: aurResult && !aurResult.error ? aurResult : null,
      aur_error: aurResult && aurResult.error ? aurResult.error : null,
    },
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

module.exports = { aggregatePackage, compareVersions, bucketRepology, getArchPackages, getAurPackage, getRepologyData };
