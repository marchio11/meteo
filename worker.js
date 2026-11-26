/**
 * Ponte Cloudflare Worker per le dashboard meteo (salotto e camera).
 *
 * Fonti:
 *   - ECOWITT (il gateway GW1200 di casa, tramite il cloud ecowitt.net):
 *       temperatura e umidità esterne (sensore sul canale ECOWITT_OUT, predefinito ch1),
 *       minima e massima di oggi calcolate dal Worker,
 *       temperatura e umidità della camera (canale ECOWITT_ROOM, predefinito ch3) se il sensore c'è,
 *       temperatura e umidità del salotto (sensore interno del gateway), con minima e massima di oggi.
 *   - METEONETWORK (stazione MAIN_STATION, predefinita mrc065 Celletta/Pentagono – Pesaro):
 *       vento, pioggia e pressione; e anche temperatura/umidità se Ecowitt non risponde.
 *
 * Perché serve il Worker: le chiavi (token MeteoNetwork, chiavi Ecowitt) non devono finire
 * nella pagina pubblica, e le due API non mandano le intestazioni CORS per il browser.
 *
 * Limiti di MeteoNetwork (5 richieste al minuto): Cloudflare può far girare più copie del
 * Worker, ognuna con la sua memoria. Per questo l'ultima risposta viene salvata in una memoria
 * CONDIVISA (Workers KV, legame METEO_KV): tutte le copie la vedono, quindi le API vengono
 * chiamate al massimo una volta ogni CACHE_SECONDS. Senza KV il Worker funziona lo stesso,
 * con la sola memoria della singola copia (come prima).
 *
 * Impostazioni del Worker (Settings → Variables and Secrets):
 *   MNW_TOKEN        (Secret)  token MeteoNetwork
 *   ALLOWED_ORIGINS  (Text)    indirizzi delle pagine, separati da virgola
 *   MAIN_STATION     (Text, facoltativa)  predefinita: mrc065
 *   RAIN_STATION     (Text, facoltativa)  predefinita: la stessa di MAIN_STATION
 *   ECOWITT_APP_KEY  (Secret)  Application Key di ecowitt.net
 *   ECOWITT_API_KEY  (Secret)  API Key di ecowitt.net
 *   ECOWITT_MAC      (Text)    MAC del GW1200, es. AA:BB:CC:DD:EE:FF
 *   ECOWITT_OUT      (Text, facoltativa)  sensore esterno: ch1 … ch8 oppure outdoor. Predefinito: ch1
 *   ECOWITT_ROOM     (Text, facoltativa)  sensore della camera: ch1 … ch8, oppure none. Predefinito: ch3
 * Legame (Settings → Bindings):
 *   METEO_KV         (KV namespace)  memoria condivisa
 *
 * Prova: aggiungere ?debug=1 all'indirizzo del Worker per vedere cosa arriva da Ecowitt
 * (solo dati meteo, mai le chiavi).
 */

const CACHE_SECONDS = 300;     // le pagine ricevono la stessa risposta per 5 minuti
const MIN_GAP_SECONDS = 60;    // mai più di un giro di chiamate al minuto
const ECO_STALE_MIN = 30;      // un dato Ecowitt più vecchio di così non viene usato
const RAIN_FIELDS = ['daily_rain', 'rain_rate'];
const TZ = 'Europe/Rome';      // per azzerare minima e massima a mezzanotte
const KV_KEY = 'stato-v1';

// Memoria della singola copia del Worker (riserva se manca la KV)
let memo = null;

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET') return json({ ok: false, error: 'metodo non permesso' }, 405, cors);

    const url = new URL(request.url);
    if (url.searchParams.get('debug') === '1') return debug(env, cors);

    const now = Date.now();
    let state = await loadState(env);

    // 1) risposta recente: la riuso
    if (state && state.body && now - state.at < CACHE_SECONDS * 1000) return ok(state.body, cors);

    // 2) qualcun altro ha appena chiamato le API: aspetto e intanto riuso l'ultimo dato
    if (state && state.callAt && now - state.callAt < MIN_GAP_SECONDS * 1000) {
      if (state.body) return ok(state.body, cors);
      return json({ ok: false, error: 'attendo un minuto prima di richiedere di nuovo i dati' }, 503, cors);
    }
    state = state || {};
    state.callAt = now;
    await saveState(env, ctx, state);   // segno subito la chiamata, così le altre copie aspettano

    // 3) chiamo le due fonti insieme
    const [mnw, eco] = await Promise.all([getMeteoNetwork(env), getEcowitt(env)]);
    if (mnw.data) state.mnw = mnw.data;          // se una fonte fallisce tengo il suo ultimo dato
    if (eco.data) state.eco = eco.data;

    if (!state.mnw && !state.eco) {
      return json({ ok: false, error: [mnw.error, eco.error].filter(Boolean).join(' · ') || 'nessun dato' }, 502, cors);
    }

    // 4) minima e massima di oggi dal sensore esterno Ecowitt (azzerate a mezzanotte)
    const out = ecoOutdoor(state.eco, now, env);
    if (out) trackMinMax(state, 'out', out);
    const indoor = ecoChannel(state.eco, 'indoor', now);   // sensore interno del gateway (salotto)
    if (indoor) trackMinMax(state, 'in', indoor);

    const data = merge(state, out, now, env);
    data.errors = [mnw.error, eco.error].filter(Boolean);
    state.body = JSON.stringify({ ok: true, fetched_at: new Date(now).toISOString(), data });
    state.at = now;
    await saveState(env, ctx, state);
    return ok(state.body, cors);
  },
};

// Minima e massima di oggi (si azzerano a mezzanotte, ora italiana)
function trackMinMax(state, p, x) {
  const day = localDay(x.time);
  if (state[p + 'Day'] !== day) { state[p + 'Day'] = day; state[p + 'Min'] = x.temp; state[p + 'Max'] = x.temp; }
  state[p + 'Min'] = Math.min(state[p + 'Min'] ?? x.temp, x.temp);
  state[p + 'Max'] = Math.max(state[p + 'Max'] ?? x.temp, x.temp);
}

/* ---------------- unione dei dati ---------------- */

// Parte dai dati MeteoNetwork (vento, pioggia, pressione) e sostituisce temperatura e
// umidità con quelle del sensore Ecowitt, se sono recenti.
function merge(state, out, now, env) {
  const m = state.mnw || {};
  const d = { ...m };
  d.mnw_observation_time_utc = m.observation_time_utc || null;
  d.wind_observation_time_utc = m.observation_time_utc || null;
  d.rain_observation_time_utc = m.rain_observation_time_utc || m.observation_time_utc || null;

  if (out) {
    d.temperature = String(out.temp);
    d.rh = out.rh === null ? null : String(out.rh);
    d.current_tmin = String(state.outMin);
    d.current_tmax = String(state.outMax);
    d.observation_time_utc = utcString(out.time);
    d.temp_source = 'ecowitt';
  } else {
    d.temp_source = 'meteonetwork';
  }
  if (!d.station_code) d.station_code = String(env.MAIN_STATION || 'mrc065').toLowerCase();

  const indoor = ecoChannel(state.eco, 'indoor', now);
  if (indoor) {
    d.indoor_temperature = String(indoor.temp);
    d.indoor_rh = indoor.rh === null ? null : String(indoor.rh);
    d.indoor_tmin = String(state.inMin);
    d.indoor_tmax = String(state.inMax);
    d.indoor_observation_time_utc = utcString(indoor.time);
  }
  const room = ecoChannel(state.eco, env.ECOWITT_ROOM || 'ch3', now);
  if (room) {
    d.room_temperature = String(room.temp);
    d.room_rh = room.rh === null ? null : String(room.rh);
    d.room_observation_time_utc = utcString(room.time);
  }
  return d;
}

/* ---------------- Ecowitt ---------------- */

async function getEcowitt(env) {
  if (!env.ECOWITT_APP_KEY || !env.ECOWITT_API_KEY || !env.ECOWITT_MAC) return { error: null }; // non configurato: si usa solo MeteoNetwork
  const q = new URLSearchParams({
    application_key: env.ECOWITT_APP_KEY, api_key: env.ECOWITT_API_KEY, mac: env.ECOWITT_MAC,
    call_back: 'all', temp_unitid: '1', pressure_unitid: '3', wind_speed_unitid: '7', rainfall_unitid: '12',
  });
  let res, j;
  try {
    res = await fetch('https://api.ecowitt.net/api/v3/device/real_time?' + q, { headers: { Accept: 'application/json' } });
    j = await res.json();
  } catch {
    return { error: 'Ecowitt non raggiungibile' };
  }
  if (!res.ok || !j || j.code !== 0) return { error: `Ecowitt errore: ${(j && j.msg) || 'HTTP ' + res.status}` };
  if (!j.data || typeof j.data !== 'object' || Array.isArray(j.data)) return { error: 'Ecowitt: nessun dato (il gateway carica su ecowitt.net?)' };
  return { data: j.data };
}

// Temperatura e umidità di un sensore: 'indoor' (gateway), 'outdoor' oppure 'ch1' … 'ch8'
function ecoChannel(eco, which, now) {
  if (!eco || !which || which === 'none') return null;
  const w = String(which).toLowerCase().trim();
  const block = w === 'outdoor' || w === 'indoor' ? eco[w] : eco['temp_and_humidity_ch' + w.replace(/\D/g, '')];
  if (!block || !block.temperature) return null;
  const temp = num(block.temperature.value);
  const time = Number(block.temperature.time) * 1000;
  if (temp === null || !time || now - time > ECO_STALE_MIN * 60e3) return null;
  const rh = block.humidity ? num(block.humidity.value) : null;
  return { temp, rh, time };
}
function ecoOutdoor(eco, now, env) {
  return ecoChannel(eco, env.ECOWITT_OUT || 'ch1', now);
}

async function debug(env, cors) {
  const eco = await getEcowitt(env);
  const now = Date.now();
  return json({
    ecowitt_configurato: !!(env.ECOWITT_APP_KEY && env.ECOWITT_API_KEY && env.ECOWITT_MAC),
    kv_collegata: !!env.METEO_KV,
    errore: eco.error || null,
    sensori_trovati: eco.data ? Object.keys(eco.data) : [],
    esterno_usato: ecoOutdoor(eco.data, now, env),
    salotto_usato: ecoChannel(eco.data, 'indoor', now),
    camera_usata: ecoChannel(eco.data, env.ECOWITT_ROOM || 'ch3', now),
    dati_ecowitt: eco.data || null,
  }, 200, cors);
}

/* ---------------- MeteoNetwork ---------------- */

async function getMeteoNetwork(env) {
  if (!env.MNW_TOKEN) return { error: 'token MeteoNetwork mancante nel Worker' };
  const mainStation = String(env.MAIN_STATION || 'mrc065').toLowerCase();
  const rainStation = String(env.RAIN_STATION || mainStation).toLowerCase();
  const main = await getStation(mainStation, env);
  if (main.error) return { error: main.error };
  const d = main.data;
  d.rain_station_code = rainStation;
  d.rain_observation_time_utc = d.observation_time_utc;
  if (rainStation !== mainStation) {
    for (const k of RAIN_FIELDS) d[k] = null;
    d.rain_observation_time_utc = null;
    await sleep(1100);   // MeteoNetwork: al massimo 1 richiesta al secondo
    const rain = await getStation(rainStation, env);
    if (rain.error) d.rain_error = rain.error;
    else {
      d.rain_observation_time_utc = rain.data.observation_time_utc;
      for (const k of RAIN_FIELDS) d[k] = rain.data[k] ?? null;
    }
  }
  return { data: d };
}

// Ultimo dato di una stazione, senza il controllo qualità di MeteoNetwork
// (il filtro a volte scarta letture intere o la sola pioggia).
async function getStation(code, env) {
  const url = `https://api.meteonetwork.it/v3/data-realtime/${encodeURIComponent(code)}?data_quality=false`;
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
    return { error: 'MeteoNetwork non raggiungibile' };
  }
  const text = await res.text().catch(() => '');
  const why = `HTTP ${res.status}${text ? ': ' + text.slice(0, 160) : ''}`;
  if (res.status === 204) return { error: `nessun dato dalla stazione ${code} (${why})` };
  if (res.status === 401) return { error: `token MeteoNetwork non valido (${why})` };
  if (res.status === 429) return { error: `troppe richieste a MeteoNetwork, riprovo più tardi (${why})` };
  if (!res.ok) return { error: `MeteoNetwork errore per ${code} (${why})` };
  let j;
  try { j = JSON.parse(text); } catch { return { error: `risposta non valida per ${code} (${why})` }; }
  const d = Array.isArray(j) ? j[0] : j;
  if (!d || !d.observation_time_utc) return { error: `nessun dato dalla stazione ${code} (${why})` };
  return { data: d };
}

/* ---------------- memoria condivisa (KV) ---------------- */

async function loadState(env) {
  if (env.METEO_KV) {
    try {
      const s = await env.METEO_KV.get(KV_KEY, 'json');
      if (s) { memo = s; return s; }
    } catch { /* KV non disponibile: uso la memoria locale */ }
  }
  return memo ? { ...memo } : null;
}
async function saveState(env, ctx, state) {
  memo = { ...state };
  if (env.METEO_KV) {
    try { await env.METEO_KV.put(KV_KEY, JSON.stringify(state)); } catch { /* pazienza: resta la memoria locale */ }
  }
}

/* ---------------- utilità ---------------- */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const utcString = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const localDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms));

function ok(body, cors) {
  return new Response(body, {
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
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
