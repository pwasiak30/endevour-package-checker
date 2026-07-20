# EOS Pkg Checker

Wyszukiwarka i porównywarka wersji pakietów: **EndeavourOS** (core/extra/multilib Arch
Linux + AUR + własne repo `endeavouros`) w zestawieniu z najnowszymi wersjami tego
samego pakietu w: **Debian**, **Ubuntu** (wszystkie wydania, w tym LTS), **Fedora**,
**openSUSE**, **Gentoo** i **Linux Mint**.

## Jak to działa

Frontend (`docs/index.html`) to statyczna strona, która woła funkcję serverless
`netlify/functions/search.js`. Funkcja ta w jednym zapytaniu agreguje dane z kilku
źródeł:

| Dystrybucja | Źródło danych | Uwagi |
|---|---|---|
| EndeavourOS — core/extra/multilib | [Arch Linux official JSON API](https://archlinux.org/packages/) | EndeavourOS używa tych repozytoriów Arch Linuksa bezpośrednio, bez przepakowywania — to źródło pokrywa zdecydowaną większość pakietów |
| EndeavourOS — AUR | [AUR RPC v5](https://aur.archlinux.org/rpc/) | |
| Debian, Ubuntu, Fedora, openSUSE, Gentoo | [Repology.org API](https://repology.org/api) | Repology śledzi dziesiątki wydań każdej z tych dystrybucji jednocześnie (np. wszystkie wersje Ubuntu od 14.04 po najnowszą, wszystkie Debiany od 11 po unstable) |
| Linux Mint | scraping `packages.linuxmint.com` (best-effort) + fallback | Repology **nie** śledzi Mint jako osobnego repo. Jeśli scraping się nie powiedzie, pokazywana jest wersja z bazowego wydania Ubuntu, na którym dana edycja Mint jest zbudowana (np. Mint 22.x → Ubuntu 24.04 LTS), oznaczona jako „estymacja” |

**Celowo pominięte:** małe, własne repo EndeavourOS (`endeavouros`, pakiety typu
`eos-*`/motywy/branding) — pliki bazy danych na mirrorach EOS są kompresowane
algorytmem XZ, co wymagałoby dodatkowej natywnej zależności w funkcji serverless
(ryzyko niestabilnego wdrożenia na Netlify). Nie wpływa to na wyszukiwanie zwykłych
pakietów aplikacji/bibliotek, bo te pochodzą z core/extra/multilib.

## Ograniczenia / rzeczy do wiedzy

- **Porównanie wersji jest przybliżone.** Różne dystrybucje stosują różne konwencje
  numeracji (epoch, sufiksy typu `+dfsg`, `fc40`, `ubuntu1`, `pkgrel`). Aplikacja
  wycina epoch i część po `+`/`~`, po czym porównuje segmenty numeryczne — to
  wystarcza dla większości pakietów, ale przy nietypowych schematach numeracji
  wynik może być mylący. Traktuj znaczniki „aktualna”/„starsza” jako wskazówkę,
  nie pewnik.
- **Repo `endeavouros`** i **Linux Mint** są zaznaczone jako best-effort, ponieważ
  nie mają stabilnego, publicznego API — w razie awarii mirrora/strony po prostu
  nie pokażą danych (reszta wyników i tak się wyświetli).
- Repology wymaga custom User-Agent i limitu 1 zapytania/s dla masowych klientów —
  tu odpytujemy go raz na wyszukiwanie, więc limit nie jest problemem.

## Rozwój lokalny

```bash
npm i -g netlify-cli
netlify dev
```

Otworzy się strona na `http://localhost:8888`, funkcja dostępna pod
`/.netlify/functions/search?q=firefox`.

## Wdrożenie

Repozytorium jest podłączone do Netlify (auto-deploy przy każdym pushu na `main`).
Konfiguracja w `netlify.toml`: katalog publikowany to `docs/`, funkcje w
`netlify/functions/`.
