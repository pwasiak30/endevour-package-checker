# EOS Pkg Checker

Wyszukiwarka i porównywarka wersji pakietów: **EndeavourOS** (core/extra/multilib Arch
Linux + AUR — **wszystkie** pakiety, ok. 131 tys.) w zestawieniu z najnowszymi wersjami
tego samego pakietu w: **Debian**, **Ubuntu** (wszystkie wydania, w tym LTS), **Fedora**,
**openSUSE**, **Gentoo**, **Linux Mint** i — jeśli dostępny — **Windows** (Chocolatey).
Przy każdej wersji: link do strony projektu/pakietu w danej dystrybucji, opis, licencja
i (jeśli Repology to zgłasza) ostrzeżenie o znanych podatnościach (CVE).

**Działa wyłącznie na GitHub — bez żadnego zewnętrznego hostingu/backendu.**

## Architektura (w 100% statyczna)

Strona jest hostowana przez **GitHub Pages** (katalog `docs/`) i sama w sobie
jest zwykłym plikiem HTML/JS bez żadnego backendu. Powód: żadne z odpytywanych
API (archlinux.org, aur.archlinux.org, repology.org) nie wysyła nagłówka
`Access-Control-Allow-Origin`, więc wywołanie ich wprost z przeglądarki
zostałoby zablokowane przez CORS — nie da się tego obejść bez backendu/proxy.

Zamiast tego dane są wyliczane **z wyprzedzeniem** przez **GitHub Actions**
(`.github/workflows/update-data.yml`), które raz dziennie (i na żądanie) pobierają
**hurtowo, paginowanymi "bulk" endpointami** (a nie pakiet-po-pakiecie) pełną bazę
każdego źródła i zapisują wynik jako statyczne pliki JSON w `docs/data/`:

- `docs/data/pkg/<litera>.json` — pakiety pogrupowane wg pierwszego znaku
  znormalizowanej nazwy (`a`–`z`, `0`–`9`, `other`) — zamiast >100 tys. osobnych
  plików (wolne dla gita i przeglądarki), ok. 36 większych "shardów". Frontend
  doładowuje tylko shard potrzebny do aktualnego zapytania.
- `docs/data/index.json` — lista **wszystkich** nazw pakietów (do
  wyszukiwania/podpowiedzi) + licznik + znacznik czasu ostatniego builda.

Frontend (`docs/index.html`) czyta te pliki tak jak każdy inny statyczny
zasób — bez CORS, bez serwera, bez zależności od czegokolwiek poza samym
GitHubem.

| Dystrybucja | Źródło danych | Sposób pobierania |
|---|---|---|
| EndeavourOS — core/extra/multilib | [Arch Linux official JSON API](https://archlinux.org/packages/) (EndeavourOS używa tych repozytoriów bezpośrednio) | pełna, paginowana lista wszystkich pakietów (ok. 64 strony po 250) |
| EndeavourOS — AUR | [AUR metadata dump](https://aur.archlinux.org/packages-meta-ext-v1.json.gz) | jeden zbiorczy plik z metadanymi wszystkich ~116 tys. pakietów AUR |
| Debian, Ubuntu, Fedora, openSUSE, Gentoo | [Repology.org bulk API](https://repology.org/api) (`/api/v1/projects/?inrepo=arch` i `?inrepo=aur`) | masowa, paginowana lista (200 projektów/stronę, max 1 zapytanie/s) — każdy wpis od razu zawiera wersje we wszystkich innych śledzonych dystrybucjach |
| Linux Mint | estymacja z wersji bazowego wydania Ubuntu (Repology nie śledzi Mint osobno) | — |
| Windows | [Chocolatey community repository](https://community.chocolatey.org/) (OData API) | pełna, paginowana lista najnowszych wersji wszystkich pakietów (ok. 100 pakietów/stronę) |

Dzięki podejściu "bulk" (masowemu pobieraniu całych baz, a nie odpytywaniu
pakiet-po-pakiecie) cały przebieg trwa rzędu kilkunastu-kilkudziesięciu minut
(głównie ze względu na limit Repology: 1 zapytanie/s), a nie godziny — mimo że
obejmuje ~131 tysięcy pakietów za jednym razem.

### Linki i dodatkowe informacje

Każdy wpis ma (jeśli źródło je udostępnia) link do strony projektu/pakietu:

- EndeavourOS/AUR: link do strony pakietu na archlinux.org / aur.archlinux.org + strona domowa projektu + opis.
- Debian/Ubuntu/Fedora/openSUSE/Gentoo: stabilny, niezależny od wydania link do trackera
  pakietu (`tracker.debian.org`, `launchpad.net/ubuntu/+source/...`,
  `src.fedoraproject.org/rpms/...`, `software.opensuse.org/package/...`,
  `packages.gentoo.org/packages/...`), licencja i krótki opis pokazywane raz w nagłówku
  karty (nie powtarzane w każdym wierszu), oraz ostrzeżenie ⚠️ CVE, jeśli Repology
  oznaczyło daną wersję jako podatną. Wydania z identyczną wersją (np. kilka wersji
  Fedory naraz) są grupowane w jeden wiersz, żeby tabela była czytelna.
- Windows (Chocolatey): strona pakietu, strona domowa projektu, link do źródła paczki (zwykle GitHub).
- Zawsze widoczny link „Zobacz na Repology.org” z pełnym zestawieniem wszystkich
  śledzonych repozytoriów dla danego pakietu naraz.

Repology samo oznacza część wpisów jako niewiarygodne (status `incorrect` /
`untrusted` / `ignored`, np. błędne dopasowanie projektu) — takie wpisy są
pomijane. Podobnie "live" ebuildy Gentoo (wersja `9999`, status `rolling`) nie
są traktowane jako "najnowsza wersja" w porównaniu, bo to nie jest realny numer
wydania, tylko wskaźnik gita HEAD.

Celowo pominięte: małe własne repo EndeavourOS (`endeavouros`, pakiety
`eos-*`/motywy/branding) — jego baza jest skompresowana XZ, co komplikowałoby
skrypt budujący bez realnej korzyści (te pakiety to głównie narzędzia EOS, nie
zwykłe aplikacje).

## Wyszukiwanie

Wyszukiwarka obejmuje **wszystkie** pakiety core/extra/multilib + AUR — nie ma
już żadnej ręcznie kuratorowanej listy. Dopasowanie nazwy działa w kilku
krokach: dokładne (bez wielkości liter) → znormalizowane (ignorując
spacje/myślniki/podkreślenia, np. „libre office” → `libreoffice-fresh`) →
częściowe (np. „firefox” pokaże listę pasujących wariantów typu
`firefox-esr`, `firefox-bin`). Podczas wpisywania pojawia się też lekka
podpowiadarka z maks. 15 najbliższymi dopasowaniami (żeby nie zapychać
przeglądarki natywnym `<datalist>` na >100 tys. pozycji).

## Ograniczenia / rzeczy do wiedzy

- **Dane nie są „na żywo”** — mają maksymalnie ~1 dzień opóźnienia (od
  ostatniego przebiegu GitHub Actions).
- **Porównanie wersji jest przybliżone.** Różne dystrybucje stosują różne
  konwencje numeracji (epoch, sufiksy typu `+dfsg`, `fc40`, `ubuntu1`,
  `pkgrel`). Traktuj znaczniki „aktualna”/„starsza” jako wskazówkę, nie pewnik.
- Repology wymaga custom User-Agent i limitu 1 zapytania/s dla masowych
  klientów — skrypt budujący (`scripts/build-full-data.js`) respektuje to przy
  paginacji bulk endpointów.
- **Pakiety jądra (`linux`, `linux-lts` itd.) są szczególnie zwodnicze.**
  Repology śledzi w Ubuntu pakiet `linux` (jądro „GA” z premiery danego
  wydania), a nie osobny, rolujący tor **HWE** (`linux-hwe-24.04` itp.), który
  domyślnie instaluje się na obrazach pulpitowych Ubuntu i Linux Mint i bywa
  wyraźnie nowszy (np. Mint 22.3 realnie ma ~6.14, a `ubuntu_24_04` w
  Repology pokazuje 6.8). Aplikacja wyświetla o tym ostrzeżenie w UI przy
  wyszukiwaniu pakietów jądra, ale liczby traktuj jako orientacyjne.
- Dopasowanie danych Repology do konkretnego pakietu Arch/AUR opiera się na
  grupowaniu projektów, jakie robi sam Repology — w rzadkich przypadkach
  (pakiety podzielone/split) kilka pakietów może dzielić te same dane
  porównawcze.

## Struktura repo

```
docs/                     # to serwuje GitHub Pages
  index.html               # cala aplikacja (frontend, bez zaleznosci)
  data/
    index.json              # lista WSZYSTKICH pakietow + licznik + kiedy ostatnio zbudowano
    pkg/<litera>.json        # dane porownawcze, shardowane wg pierwszej litery nazwy
scripts/
  lib/
    aggregate.js             # bucketRepology(), porownywanie wersji, estymacja Mint
    bulk-sources.js           # hurtowe/paginowane pobieranie Arch/AUR/Repology/Chocolatey
    normalize.js               # normalizeName()/shardKey() - identyczne jak w frontendzie
  build-full-data.js          # generuje docs/data/pkg/*.json + index.json (Actions)
.github/workflows/
  update-data.yml              # codzienny cron + reczny "Run workflow"
```

## Rozwój lokalny

```bash
node scripts/build-full-data.js
```

Uwaga: to pobiera CAŁĄ bazę (ok. 131 tys. pakietów) i przy pełnym przebiegu
Repology-bulk trwa rząd kilkunastu minut (limit 1 zapytanie/s). Do szybkich
testów lokalnych można ograniczyć liczbę stron bulk-crawla Repology/Chocolatey
zmienną środowiskową `BUILD_TEST_MAX_PAGES=2 node scripts/build-full-data.js`
(NIE używać tego w produkcyjnym przebiegu przez Actions — dawałoby niepełne dane).

Potem po prostu otwórz `docs/index.html` w przeglądarce (albo `python3 -m http.server`
w katalogu `docs/`, żeby `fetch('data/index.json')` działało spod `http://`, nie `file://`).

## Włączenie GitHub Pages (jednorazowo)

Ustawienia repo → **Pages** → Source: **Deploy from a branch** → Branch: **main** /
folder **`/docs`**.
