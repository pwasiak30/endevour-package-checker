#!/usr/bin/env node
// scripts/build-full-data.js
//
// Buduje statyczna baze danych dla WSZYSTKICH pakietow EndeavourOS (Arch
// core/extra/multilib + AUR - razem ok. 130 000 nazw), a nie tylko wybranej
// listy. Zamiast odpytywac kazdy pakiet osobno (co przy takiej skali byloby
// zarowno bardzo wolne, jak i niegrzeczne wobec API), korzysta z masowych,
// paginowanych "bulk" endpointow kazdego zrodla (patrz scripts/lib/
// bulk-sources.js) - caly przebieg to od kilkunastu do kilkudziesieciu minut
// (glownie ze wzgledu na limit Repology: max 1 zapytanie/s), a nie godziny.
//
// Uruchamiane WYLACZNIE przez GitHub Actions (.github/workflows/
// update-data.yml) - nigdy w przegladarce.
//
// Wynik:
//   docs/data/pkg/<shard>.json  - pakiety pogrupowane wg pierwszego znaku
//                                  znormalizowanej nazwy (a-z, 0-9, "other")
//   docs/data/index.json         - lista WSZYSTKICH nazw pakietow (do
//                                  wyszukiwania/podpowiedzi) + znacznik czasu

const fs = require('fs');
const path = require('path');
const {
  bucketRepology,
  compareVersions,
  getMintData,
} = require('./lib/aggregate');
const {
  fetchAllArchPackages,
  fetchAllAurPackages,
  fetchRepologyBulkMap,
  fetchAllChocolateyPackages,
} = require('./lib/bulk-sources');
const { normalizeName, shardKey } = require('./lib/normalize');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'docs', 'data');
const PKG_DIR = path.join(DATA_DIR, 'pkg');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const testLimit = process.env.BUILD_TEST_MAX_PAGES
    ? Number(process.env.BUILD_TEST_MAX_PAGES)
    : undefined; // tylko do lokalnych testow na probce - nieustawione w Actions

  log('1/6 Pobieram pelna liste pakietow Arch (core/extra/multilib)...');
  const archMap = await fetchAllArchPackages(log);
  log(`    -> ${archMap.size} pakietow oficjalnych repo.`);

  log('2/6 Pobieram pelny dump metadanych AUR...');
  const aurMap = await fetchAllAurPackages(log);
  log(`    -> ${aurMap.size} pakietow AUR.`);

  log('3/6 Pobieram masowe dane Repology dla repo=arch...');
  const repologyArch = await fetchRepologyBulkMap('arch', log, { maxPages: testLimit });
  log('4/6 Pobieram masowe dane Repology dla repo=aur...');
  const repologyAur = await fetchRepologyBulkMap('aur', log, { maxPages: testLimit });
  const repologyMap = new Map([...repologyAur, ...repologyArch]); // arch nadpisuje przy kolizji

  log('5/6 Pobieram pelna liste pakietow Chocolatey (Windows)...');
  const chocoMap = await fetchAllChocolateyPackages(log, { maxPages: testLimit });

  log('6/6 Sklejam i zapisuje pliki wynikowe...');
  const allNames = new Set([...archMap.keys(), ...aurMap.keys()]);
  log(`    Laczna liczba unikalnych pakietow do zapisania: ${allNames.size}`);

  const shards = new Map(); // shardKey -> { pkgname: record }
  const generatedAt = new Date().toISOString();
  let withRepologyData = 0;
  let withWindowsData = 0;

  for (const name of allNames) {
    const archRow = archMap.get(name) || null;
    const aurRow = aurMap.get(name) || null;
    const repoEntries = repologyMap.get(name) || [];
    const buckets = bucketRepology(repoEntries);
    const mint = getMintData(buckets.ubuntu);
    const windows = chocoMap.get(normalizeName(name)) || null;

    if (repoEntries.length) withRepologyData++;
    if (windows) withWindowsData++;

    let referenceVersion = archRow ? archRow.version : null;
    if (aurRow && (!referenceVersion || compareVersions(aurRow.version, referenceVersion) > 0)) {
      referenceVersion = aurRow.version;
    }

    const record = {
      endeavouros: {
        arch_repos: archRow ? [archRow] : [],
        aur: aurRow,
      },
      reference_version: referenceVersion,
      debian: buckets.debian,
      ubuntu: buckets.ubuntu,
      fedora: buckets.fedora,
      opensuse: buckets.opensuse,
      gentoo: buckets.gentoo,
      mint,
      windows,
      repology_project_url: `https://repology.org/project/${encodeURIComponent(name)}/versions`,
      generated_at: generatedAt,
    };

    const shard = shardKey(name);
    if (!shards.has(shard)) shards.set(shard, {});
    shards.get(shard)[name] = record;
  }

  fs.mkdirSync(PKG_DIR, { recursive: true });
  // wyczysc stare pliki shardow (na wypadek zmiany zestawu liter miedzy przebiegami)
  for (const f of fs.readdirSync(PKG_DIR)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(PKG_DIR, f));
  }
  for (const [shard, obj] of shards) {
    fs.writeFileSync(path.join(PKG_DIR, `${shard}.json`), JSON.stringify(obj));
  }
  log(`    Zapisano ${shards.size} plikow-shardow w docs/data/pkg/.`);

  fs.writeFileSync(
    INDEX_FILE,
    JSON.stringify({
      packages: [...allNames].sort(),
      count: allNames.size,
      with_repology_data: withRepologyData,
      with_windows_data: withWindowsData,
      last_build: generatedAt,
    })
  );

  log(`Gotowe. Razem: ${allNames.size} pakietow (${archMap.size} oficjalne + ${aurMap.size} AUR), ` +
    `${withRepologyData} z danymi Repology, ${withWindowsData} z danymi Chocolatey.`);
}

main().catch((e) => {
  console.error('Nieoczekiwany blad:', e);
  process.exitCode = 1;
});
