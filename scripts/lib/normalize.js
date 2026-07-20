// scripts/lib/normalize.js
//
// Normalizacja nazwy pakietu do klucza porownawczego/shardu. UWAGA: logika
// normalizeName() jest ZDUBLOWANA w docs/index.html (frontend nie moze
// wczytywac modulow Node) - jesli zmieniasz cos tutaj, zmien identycznie tam.

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Pliki-shardy trzymaja pakiety pogrupowane wg pierwszego znaku znormalizowanej
// nazwy (a-z / 0-9), zeby zamiast >100 000 osobnych plikow JSON (wolne dla
// gita i przegladarki) miec ~37 wiekszych plikow.
function shardKey(name) {
  const c = normalizeName(name)[0];
  if (!c) return 'other';
  return /[a-z0-9]/.test(c) ? c : 'other';
}

module.exports = { normalizeName, shardKey };
