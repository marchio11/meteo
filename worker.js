/**
 * Ponte Cloudflare Worker per la dashboard meteo.
 *
 * Perché serve: l'API MeteoNetwork richiede un token personale e non permette
 * chiamate dirette dal browser (niente intestazioni CORS). Il Worker:
 *   - tiene il token segreto (non finisce mai nella pagina pubblica)
 *   - legge tutti i dati da una stazione (MAIN_STATION, predefinita mrc065
 *     Celletta/Pentagono – Pesaro). Facoltativamente la pioggia può arrivare
 *     da un'altra stazione (RAIN_STATION)
 *   - riusa la stessa risposta per 5 minuti e non chiama MeteoNetwork
 *     più di una volta al minuto, anche se la pagina viene ricaricata spesso
 *   - aggiunge le intestazioni CORS per la tua pagina
 *
 * Nota: su un indirizzo *.workers.dev la cache di Cloudflare (caches.default)
 * non ha effetto, quindi la risposta viene tenuta anche in memoria.
 *
 * Impostazioni del Worker (Settings → Variables and Secrets):
 *   MNW_TOKEN        (Secret)  il token MeteoNetwork, es. 1234|abcdEf...
 *   ALLOWED_ORIGINS  (Text)    https://TUONOME.github.io   (più origini separate da virgola, * = tutte)
 *   MAIN_STATION     (Text, facoltativa)  predefinita: mrc065 (Celletta/Pentagono)
 *   RAIN_STATION     (Text, facoltativa)  predefinita: la stessa di MAIN_STATION
 *   (la vecchia variabile STATION non viene più usata e si può cancellare)
 */

const CACHE_SECONDS = 300;    // riuso della risposta valida
const MIN_GAP_SECONDS = 60;   // mai più di un giro di chiamate a MeteoNetwork al minuto
const RAIN_FIELDS = ['daily_rain', 'rain_rate'];

// Memoria del Worker (resta finché Cloudflare tiene attiva l'istanza)
let memo = { body: null, at: 0 };
let lastCallAt = 0;

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ ok: false, error: 'metodo non permesso' }, 405, cors);
    if (!env.MNW_TOKEN) return json({ ok: false, error: 'token MeteoNetwork mancante nel Worker' }, 500, cors);

    const mainStation = String(env.MAIN_STATION || 'mrc065').toLowerCase();
    const rainStation = String(env.RAIN_STATION || mainStation).toLowerCase();
    const now = Date.now();

    // 1) risposta recente in memoria
    if (memo.body && now - memo.at < CACHE_SECONDS * 1000) return ok(memo.body, cors);

    // 2) cache Cloudflare (funziona solo con un dominio personalizzato)
    const cache = caches.default;
    const cacheKey = new Request(`https://cache.internal/mnw/${mainStation}-${rainStation}`);
    try {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const body = await hit.text();
        memo = { body, at: now };
        return ok(body, cors);
      }
    } catch { /* cache non disponibile */ }

    // 3) protezione dai limiti: se ho chiamato da meno di un minuto, non richiamo
    if (now - lastCallAt < MIN_GAP_SECONDS * 1000) {
      if (memo.body) return ok(memo.body, cors);
      return json({ ok: false, error: 'attendo un minuto prima di richiedere di nuovo i dati' }, 503, cors);
    }
    lastCallAt = now;

    // Le stazioni si leggono SENZA il controllo qualità di MeteoNetwork
    // (il filtro a volte scarta letture intere o la sola pioggia).

    // 4) stazione principale (obbligatoria)
    const main = await getStation(mainStation, env);
    if (main.error) {
      if (main.error.startsWith('token MeteoNetwork non valido')) return json({ ok: false, error: main.error }, 502, cors);
      return fallback(main.error, main.status, cors);
    }
    const d = main.data;
    d.rain_station_code = rainStation;
    d.rain_observation_time_utc = d.observation_time_utc;

    // 5) pioggia da un'altra stazione, solo se RAIN_STATION è diversa
    if (rainStation !== mainStation) {
      for (const k of RAIN_FIELDS) d[k] = null;
      d.rain_observation_time_utc = null;
      await sleep(1100); // MeteoNetwork chiede al massimo 1 richiesta al secondo
      const rain = await getStation(rainStation, env);
      if (rain.error) {
        d.rain_error = rain.error;
      } else {
        const r = rain.data;
        d.rain_observation_time_utc = r.observation_time_utc;
        for (const k of RAIN_FIELDS) d[k] = r[k] ?? null;
      }
    }

    const body = JSON.stringify({ ok: true, fetched_at: new Date().toISOString(), data: d });
    memo = { body, at: now };
    ctx.waitUntil(cache.put(cacheKey, new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_SECONDS}` },
    })).catch(() => {}));

    return ok(body, cors);
  },
};

// Legge l'ultimo dato di una stazione (di norma senza filtro qualità).
// Restituisce { data } oppure { error, status }.
async function getStation(code, env, quality = false) {
  const url = `https://api.meteonetwork.it/v3/data-realtime/${encodeURIComponent(code)}` +
    (quality ? '' : '?data_quality=false');
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.MNW_TOKEN}`,
        Accept: 'application/json',
        'User-Agent': 'MeteoDashboardPesaro/1.0 (Cloudflare Worker, uso personale)',
      },
    });
  } catch {
    return { error: 'MeteoNetwork non raggiungibile', status: 502 };
  }
  // Testo della risposta (accorciato), riportato negli errori per capire cosa è successo
  const text = await res.text().catch(() => '');
  const why = `HTTP ${res.status}${text ? ': ' + text.slice(0, 160) : ''}`;
  if (res.status === 204) return { error: `nessun dato dalla stazione ${code} (${why})`, status: 200 };
  if (res.status === 401) return { error: `token MeteoNetwork non valido (${why})`, status: 502 };
  if (res.status === 429) return { error: `troppe richieste a MeteoNetwork, riprovo più tardi (${why})`, status: 503 };
  if (!res.ok) return { error: `MeteoNetwork errore per ${code} (${why})`, status: 502 };
  let j;
  try { j = JSON.parse(text); } catch { return { error: `risposta non valida per ${code} (${why})`, status: 502 }; }
  const d = Array.isArray(j) ? j[0] : j;
  if (!d || !d.observation_time_utc) return { error: `nessun dato dalla stazione ${code} (${why})`, status: 200 };
  return { data: d };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// In caso di errore, se ho un dato precedente lo restituisco:
// è la pagina a decidere se è troppo vecchio da mostrare.
function fallback(error, status, cors) {
  if (memo.body) return ok(memo.body, cors);
  return json({ ok: false, error }, status, cors);
}

function ok(body, cors) {
  return new Response(body, {
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0] || '');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
