# EOS Pkg Checker

Wyszukiwarka i porównywarka wersji pakietów: **EndeavourOS** (core/extra/multilib Arch
Linux + AUR) w zestawieniu z najnowszymi wersjami tego samego pakietu w: **Debian**,
**Ubuntu** (wszystkie wydania, w tym LTS), **Fedora**, **openSUSE**, **Gentoo** i
**Linux Mint**.

**Działa wyłącznie na GitHub — bez żadnego zewnętrznego hostingu/backendu.**

## Architektura (w 100% statyczna)

Strona jest hostowana przez **GitHub Pages** (katalog `docs/`) i sama w sobie
jest zwykłym plikiem HTML/JS bez żadnego backendu. Powód: żadne z odpytywanych
API (archlinux.org, aur.archlinux.org, repology.org) nie wysyła nagłówka
`Access-Control-Allow-Origin`, więc wywołanie ich wprost z przeglądarki
zostałoby zablokowane przez CORS — nie da się tego obejść bez backendu/proxy.

Zamiast tego dane są wyliczane **z wyprzedzeniem** przez **GitHub Actions**
(`.github/workflows/update-data.yml`), które codziennie (i na żądanie) odpytują
wszystkie źródła i zapisują wynik jako statyczne pliki JSON w `docs/data/`:

- `docs/data/<nazwa-pakietu>.json` — pełne dane porównawcze dla jednego pakietu,
- `docs/data/index.json` — lista wszystkich dostępnych pakietów (do
  podpowiedzi/autouzupełniania) + znacznik czasu ostatniego builda.

Frontend (`docs/index.html`) czyta te pliki tak jak każdy inny statyczny
zasób — bez CORS, bez serwera, bez zależności od czegokolwiek poza samym
GitHubem.

| Dystrybucja | Źródło danych |
|---|---|
| EndeavourOS — core/extra/multilib | [Arch Linux official JSON API](https://archlinux.org/packages/) (EndeavourOS używa tych repozytoriów bezpośrednio) |
| EndeavourOS — AUR | [AUR RPC v5](https://aur.archlinux.org/rpc/) |
| Debian, Ubuntu, Fedora, openSUSE, Gentoo | [Repology.org API](https://repology.org/api) (śledzi dziesiątki wydań każdej dystrybucji naraz) |
| Linux Mint | estymacja z wersji bazowego wydania Ubuntu (Repology nie śledzi Mint osobno) |

Celowo pominięte: małe własne repo EndeavourOS (`endeavouros`, pakiety
`eos-*`/motywy/branding) — jego baza jest skompresowana XZ, co komplikowałoby
skrypt budujący bez realnej korzyści (te pakiety to głównie narzędzia EOS, nie
zwykłe aplikacje).

## Ograniczenie: tylko pakiety z bazy

Ponieważ nie ma backendu obsługującego zapytania na żywo, wyszukiwarka działa
tylko dla pakietów, które są już w `docs/data/`. Lista startowa (`data/packages.txt`)
zawiera ok. 200 popularnych pakietów. Żeby dodać kolejny:

1. Wejdź w zakładkę **Actions** tego repo → workflow **„Update package data”** → **Run workflow**.
2. Wpisz nazwę pakietu w pole `package` i uruchom.
3. Po ok. minucie pojawi się w bazie (workflow sam dopisuje go też do `data/packages.txt`,
   więc od tej pory będzie odświeżany razem z resztą przy każdym codziennym przebiegu).

Pełne, zaplanowane odświeżenie (wszystkie pakiety z listy) leci automatycznie
codziennie o 4:17 UTC — to samo można też odpalić ręcznie (Run workflow bez
wypełniania pola `package`).

## Ograniczenia / rzeczy do wiedzy

- **Dane nie są „na żywo”** — mają maksymalnie ~1 dzień opóźnienia (albo tyle,
  ile minęło od ostatniego ręcznego odświeżenia danego pakietu).
- **Porównanie wersji jest przybliżone.** Różne dystrybucje stosują różne
  konwencje numeracji (epoch, sufiksy typu `+dfsg`, `fc40`, `ubuntu1`,
  `pkgrel`). Traktuj znaczniki „aktualna”/„starsza” jako wskazówkę, nie pewnik.
- Repology wymaga custom User-Agent i limitu 1 zapytania/s dla masowych
  klientów — skrypt budujący (`scripts/build-data.js`) robi 1,2 s przerwy
  między pakietami, żeby tego przestrzegać.
- **Pakiety jądra (`linux`, `linux-lts` itd.) są szczególnie zwodnicze.**
  Repology śledzi w Ubuntu pakiet `linux` (jądro „GA” z premiery danego
  wydania), a nie osobny, rolujący tor **HWE** (`linux-hwe-24.04` itp.), który
  domyślnie instaluje się na obrazach pulpitowych Ubuntu i Linux Mint i bywa
  wyraźnie nowszy (np. Mint 22.3 realnie ma ~6.14, a `ubuntu_24_04` w
  Repology pokazuje 6.8). Aplikacja wyświetla o tym ostrzeżenie w UI przy
  wyszukiwaniu pakietów jądra, ale liczby traktuj jako orientacyjne.

## Struktura repo

```
docs/                  # to serwuje GitHub Pages
  index.html           # cala aplikacja (frontend, bez zaleznosci)
  data/
    index.json          # lista pakietow + kiedy ostatnio zbudowano
    <pakiet>.json        # dane porownawcze dla jednego pakietu
data/
  packages.txt          # lista pakietow odswiezanych automatycznie
scripts/
  lib/aggregate.js       # logika odpytywania Arch/AUR/Repology + porownania
  build-data.js           # generuje docs/data/*.json (uruchamiane przez Actions)
.github/workflows/
  update-data.yml         # codzienny cron + workflow_dispatch (recznie/pojedynczy pakiet)
```

## Rozwój lokalny

```bash
node scripts/build-data.js            # odswieza WSZYSTKIE pakiety z data/packages.txt
node scripts/build-data.js firefox    # odswieza/dodaje jeden pakiet
```

Potem po prostu otwórz `docs/index.html` w przeglądarce (albo `python3 -m http.server`
w katalogu `docs/`, żeby `fetch('data/index.json')` działało spod `http://`, nie `file://`).

## Włączenie GitHub Pages (jednorazowo)

Ustawienia repo → **Pages** → Source: **Deploy from a branch** → Branch: **main** /
folder **`/docs`**.
