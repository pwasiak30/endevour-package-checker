#!/usr/bin/env node
// scripts/build-data.js
//
// Generuje docs/data/<pakiet>.json dla kazdego pakietu z data/packages.txt
// (albo tylko dla jednego pakietu podanego jako argument / zmienna PACKAGE -
// tak wywoluje to workflow_dispatch z inputem "package"). Uruchamiane przez
// GitHub Actions (.github/workflows/update-data.yml) - NIE w przegladarce.
//
// Wyniki trafiaja do docs/data/, ktore GitHub Pages serwuje jako zwykle,
// statyczne pliki - frontend czyta je bez zadnego backendu i bez CORS.

const fs = require('fs');
const path = require('path');
const { aggregatePackage } = require('./lib/aggregate');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'docs', 'data');
const PACKAGES_FILE = path.join(ROOT, 'data', 'packages.txt');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

const NAME_RE = /^[a-zA-Z0-9+._-]{1,100}$/;

function loadPackageList() {
  const single = process.argv[2] || process.env.PACKAGE;
  if (single) {
    return [single.trim()].filter(Boolean);
  }
  const raw = fs.readFileSync(PACKAGES_FILE, 'utf8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function loadExistingIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    // index.json na dysku ma ksztalt {packages, details, last_build} - do
    // pracy potrzebujemy tylko plaskiej mapy details (nazwa -> metadane).
    return parsed && typeof parsed === 'object' && parsed.details ? parsed.details : {};
  } catch {
    return {};
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const names = [...new Set(loadPackageList())];
  const invalid = names.filter((n) => !NAME_RE.test(n));
  for (const n of invalid) {
    console.error(`Pomijam nieprawidlowa nazwe pakietu: ${JSON.stringify(n)}`);
  }
  const valid = names.filter((n) => NAME_RE.test(n));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const index = loadExistingIndex();

  console.log(`Buduje dane dla ${valid.length} pakiet(ow)...`);

  let ok = 0;
  let failed = 0;
  for (const name of valid) {
    try {
      const data = await aggregatePackage(name);
      fs.writeFileSync(
        path.join(DATA_DIR, `${name}.json`),
        JSON.stringify(data, null, 2)
      );
      index[name] = {
        eos_version: data.reference_version || null,
        repology_ok: data.repology_ok,
        updated_at: data.generated_at,
      };
      ok++;
      console.log(`  OK: ${name} (eos=${data.reference_version || '?'}, repology_ok=${data.repology_ok})`);
    } catch (e) {
      failed++;
      console.error(`  BLAD: ${name}: ${e.message}`);
    }
    // Repology prosi o max 1 zapytanie/s dla masowych klientow - malo
    // opoznienie miedzy pakietami, zeby byc dobrym obywatelem sieci.
    await sleep(1200);
  }

  fs.writeFileSync(
    INDEX_FILE,
    JSON.stringify(
      {
        packages: Object.keys(index).sort(),
        details: index,
        last_build: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log(`Gotowe. OK: ${ok}, bledy: ${failed}. Index: ${Object.keys(index).length} pakiet(ow).`);
  if (ok === 0 && valid.length > 0) {
    process.exitCode = 1; // caly build padl - niech Action to pokaze jako czerwony
  }
}

main().catch((e) => {
  console.error('Nieoczekiwany blad:', e);
  process.exitCode = 1;
});
