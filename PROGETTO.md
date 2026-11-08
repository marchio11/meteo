# Dashboard meteo – Pesaro (Villa Ceccolini)

Dashboard meteo a pagina singola (HTML, CSS e JavaScript, senza framework) per un
tablet Lenovo Yoga Tab (Android 10) in orizzontale, a schermo intero, tema scuro,
caratteri grandi leggibili da lontano.

- **Pagina pubblicata:** https://marchio11.github.io/meteo/ (GitHub Pages, repository `marchio11/meteo`, ramo `main`, cartella principale)
- **Ponte dati (Cloudflare Worker):** https://meteo-ponte.andrea-marchionni11.workers.dev
- **Posizione di casa:** 43.86655146106417, 12.839180387625616 (Villa Ceccolini, Pesaro)

> Nota per chi riprende il lavoro (anche Claude): leggi questo file prima di modificare
> qualcosa. Le sezioni "Decisioni" e "Problemi già risolti" spiegano scelte che
> sembrano strane ma hanno un motivo preciso.

---

## File

| File | Cosa contiene |
|---|---|
| `index.html` | Tutta la dashboard: stile, struttura e codice. In cima allo script c'è il blocco `CONFIG`, l'unica parte da cambiare di solito. |
| `worker.js` | Codice del Cloudflare Worker (il "ponte" verso MeteoNetwork). **Non** viene pubblicato da GitHub: va incollato a mano su Cloudflare. |
| `manifest.webmanifest` | Permette di installare la pagina come app a schermo intero in orizzontale. |
| `icon-192.png`, `icon-512.png` | Icone dell'app. |
| `PROGETTO.md` | Questa nota. |

---

## Layout

**Intestazione:** "Pesaro – Villa Ceccolini – Dati aggiornati alle HH:MM" (orario dell'ultimo
dato della stazione, arancione se più vecchio di 30 min); a destra pallino verde
(schermo sempre acceso attivo), data, orologio, pulsante **ⓘ** (fonti dei dati, si
chiude da solo dopo 8 s o con un tocco) e pulsante **⛶** (schermo intero).

**Metà sinistra** (griglia a 6 colonne; tutti i titoli dei riquadri centrati):

1. Temperatura attuale con massima e minima del giorno (tutta la larghezza)
2. Umidità | Pioggia oggi (con ultima ora e intensità) | Vento (velocità, freccia, raffica e direzione) — un terzo di larghezza ciascuno
3. Pressione (valore in hPa, freccia verde ↑ in aumento, rossa ↓ in diminuzione, grigia ↔ stabile, variazione "+1,2 in 3 ore" e mini grafico a barre: −24h, −18h, −12h, −9h, −6h, −3h, Ora; la barra "Ora" prende il colore della freccia) | Prossimi giorni (domani e dopodomani: sigla DOM/LUN…, icona, **minima / massima**, 💧 probabilità di pioggia)
4. Striscia alba/tramonto: ☀️ Alba a sinistra, 🌙 Tramonto a destra, senza separatori

**Metà destra:**

1. Radar animato della Protezione Civile, centrato su casa (segnalino rosso)
2. Riquadro avvisi pioggia: titolo grande ("Sta piovendo", "Pioggia tra X minuti",
   "Nessuna pioggia prevista"…) e barre: prima barra **"Ora"** = pioggia misurata dalla
   stazione, poi le prossime 5 ore intere con mm e probabilità.

---

## Fonti dei dati

| Dato | Fonte | Note |
|---|---|---|
| Temperatura, min/max, umidità, vento, pioggia, pressione | **MeteoNetwork, stazione `mrc065` Celletta/Pentagono (Pesaro)**, tramite il Worker | ~3-4 km da casa. Licenza CC BY 4.0. |
| Barre orarie pioggia, "Pioggia tra X minuti", "fino alle…" | **Visual Crossing** (gratis, senza chiave) | Solo dati orari nel piano gratuito. |
| Previsione prossimi 2 giorni | **Visual Crossing** (stessa richiesta delle barre) | Icona, tempmin, tempmax, precipprob. |
| Riserva se Visual Crossing non risponde | **Open-Meteo** | Orario + giornaliero. CC BY 4.0. |
| Radar | **Radar-DPC, Dipartimento della Protezione Civile** (prodotto SRI, WMS) | Ultima ora, un'immagine ogni 5 min. CC BY-SA 4.0. |
| Radar di riserva | **RainViewer** | Se il DPC non risponde. |
| Mappa di base | **Esri** (World Dark Gray) | |
| Alba e tramonto | Calcolo astronomico nella pagina | Nessun servizio esterno. |

---

## Configurazione

### `index.html` → blocco `CONFIG`

| Voce | Valore | Significato |
|---|---|---|
| `WORKER_URL` | `https://meteo-ponte.andrea-marchionni11.workers.dev` | Indirizzo del ponte |
| `PLACE_LABEL` | `- Villa Ceccolini` | Nome accanto a "Pesaro" |
| `LAT`, `LON` | coordinate di casa | Segnalino, centro radar, previsioni, alba/tramonto |
| `REFRESH_MIN` | 10 | Aggiornamento dati stazione e previsioni (il radar ogni 5) |
| `STALE_MIN` | 30 | Oltre questi minuti il dato stazione è "vecchio" e i valori vengono nascosti |
| `RAIN_MM_H` | 0.1 | Soglia mm/ora per considerare un'ora "di pioggia" (se probabile ≥ 40%; ≥ 0,3 mm conta sempre) |
| `ALERT_WITHIN_MIN` | 60 | Banner grande se la pioggia arriva entro questi minuti |
| `RADAR_ZOOM` | 8 | Zoom della mappa |
| `FORECAST_BARS` | true | `false` nasconde le barre orarie |

### Cloudflare Worker → Settings → Variables and Secrets

| Variabile | Tipo | Valore |
|---|---|---|
| `MNW_TOKEN` | Secret | Token MeteoNetwork (non scade; si ottiene con `POST https://api.meteonetwork.it/v3/login` con email e password di my.meteonetwork.it) |
| `ALLOWED_ORIGINS` | Text | `https://marchio11.github.io` |
| `MAIN_STATION` | Text, facoltativa | Predefinita `mrc065` |
| `RAIN_STATION` | Text, facoltativa | Predefinita = `MAIN_STATION` (serve solo se la pioggia deve arrivare da un'altra stazione) |

La vecchia variabile `STATION` non è più usata.

---

## Come pubblicare una modifica

- **`index.html`, manifest, icone:** caricarli nel repository `marchio11/meteo` (o fare commit sul ramo `main`). GitHub Pages pubblica in 1-2 minuti.
- **`worker.js`:** su Cloudflare → Worker → **Edit code** → incollare → **Deploy**. Dopo il Deploy aspettare 2-3 minuti prima di aprire la dashboard (vedi limiti MeteoNetwork).
- **Cache:** GitHub Pages fa tenere la pagina in cache fino a 10 minuti. Sul PC: Ctrl+F5. Sul tablet: chiudere e riaprire l'app, oppure aprire una volta `https://marchio11.github.io/meteo/?v=N` in Chrome. La dashboard comunque si ricarica da sola una volta al giorno.

### Prove senza dati reali
Aggiungere all'indirizzo: `?demo=1` (dati di esempio), `?demo=stale` (dato vecchio),
`?demo=rain` (pioggia prevista tra poco), `?demo=raining` (sta piovendo), `?demo=off`.

---

## Decisioni (e perché)

- **Serve il Worker:** l'API MeteoNetwork richiede un token (che non deve finire nella pagina pubblica) e non invia intestazioni CORS, quindi il browser non può chiamarla direttamente.
- **Stazioni lette senza controllo qualità** (`data_quality=false`): il filtro di MeteoNetwork scartava letture intere o la sola pioggia. Nessuna scritta "non validato" in pagina (richiesta esplicita).
- **Stazione `mrc065`:** scelta dopo aver scartato
  - `mrc029` Montelabbate: sensori di temperatura/umidità/vento bloccati (es. 9,4 °C e 82% fissi tutto il giorno, vento 0); funzionava solo il pluviometro;
  - `mrc085` Villa Fastiggi: il proprietario non permette la distribuzione via API ("the weather station license does not allow the distribution of weather data"). Non leggere i dati dal sito web aggirando questa scelta.
- **Previsione oraria da Visual Crossing:** Open-Meteo a 15 minuti (ICON-D2) e altri modelli davano risultati in contrasto con la pioggia reale. Nessuna fonte gratuita offre un nowcast radar per l'Italia (il nowcast di RainViewer è vuoto, il DPC non lo pubblica). Le barre sono quindi orarie, non a 30 minuti: le mezz'ore di Visual Crossing sono a pagamento.
- **"Sta piovendo" ha la precedenza sulle previsioni:** si attiva se la stazione (dato non vecchio) segna intensità > 0 o se la pioggia di oggi è aumentata negli ultimi 20 minuti.
- **Pioggia ultima ora:** l'API dà solo il totale da mezzanotte; la pagina salva le letture nel browser (`localStorage`, chiave `rainHist_<stazione>`) e somma gli incrementi. Serve ~45 minuti di pagina aperta prima che compaia; ogni dispositivo ha il suo storico.
- **Tendenza della pressione:** l'API dà solo il valore attuale (`smlp`, pressione al livello del mare; il Worker la inoltra già, non serve modificarlo). La pagina salva le letture nel browser (`localStorage`, chiave `pressHist_<stazione>`) e confronta il valore attuale con quello di circa 3 ore prima. Serve almeno 1 ora di pagina aperta prima che compaia la freccia (prima si legge "tendenza dalle HH:MM"). Lo storico copre 25 ore e alimenta anche le barre: ogni barra usa la lettura più vicina a quell'ora (entro 40 minuti); se manca, la barra resta appena accennata e senza valore. Le barre si riempiono quindi man mano, del tutto dopo 24 ore di pagina aperta; ogni dispositivo ha il suo storico. Scala delle barre: dal minimo al massimo con almeno 6 hPa di escursione, così le piccole oscillazioni restano piccole. Variazioni sotto 0,5 hPa = "stabile". Costanti `PRESS_SPAN_MIN`, `PRESS_MIN_SPAN`, `PRESS_STEADY`, `PRESS_BARS_H` nello script.
- **Radar DPC ricolorato:** lo stile ufficiale disegna la pioggia debole quasi trasparente; un filtro SVG (`#dpcColor`) la ricolora (azzurro → blu → verde → giallo → rosso → viola, scala indicativa). Si parte dall'istante precedente all'ultimo annunciato perché l'ultimo a volte non è ancora pronto (immagine vuota).
- **Mappa Esri** invece di CARTO: le tile CARTO ora mostrano "API KEY REQUIRED".

---

## Problemi già risolti (da non reintrodurre)

- **Cache del Worker su `*.workers.dev`:** `caches.default` lì non funziona, quindi ogni richiesta arrivava a MeteoNetwork e si superava il limite (5 richieste/minuto, max 1 al secondo). Ora il Worker tiene la risposta in memoria per 5 minuti e non chiama MeteoNetwork più di una volta al minuto; in caso di errore restituisce l'ultimo dato valido.
- **Spazio vuoto in basso a sinistra:** con l'avviso arancione nascosto, i riquadri finivano in una riga ad altezza automatica. Ora `.left` è una colonna flex e `.tiles` ha `flex: 1`.
- **Storico pioggia mescolato tra stazioni:** ora la chiave dipende dalla stazione.

---

## Tablet

- App installata da Chrome (⋮ → Installa app / Aggiungi a schermata Home).
- Schermo sempre acceso: Screen Wake Lock API (pallino verde; toccare lo schermo una volta all'avvio) + Opzioni sviluppatore → "Rimani attivo" con il caricatore collegato.
- Luminosità adattiva attiva nelle impostazioni Display.

---

## Idee per il futuro

- Cercare una fonte gratuita con previsioni a 15-30 minuti più affidabile di quelle provate.
