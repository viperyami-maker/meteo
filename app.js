"use strict";

/* =========================================================
   Météo — appli mobile (PWA)
   Données : Open-Meteo (gratuit, sans clé API)
   ========================================================= */

const $ = (id) => document.getElementById(id);
const FALLBACK = { name: "Alger", admin: "Alger", country: "Algérie", lat: 36.7538, lon: 3.0588 };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  place: store.get("meteo.place", null),
  cities: store.get("meteo.cities", []),
  unit: store.get("meteo.unit", "C"),
  model: store.get("meteo.model", "mf"),
  data: null,
  loadedAt: 0,
};

/* ---------------- Modèles de prévision ----------------
   "chain" = ordre de priorité : on prend la valeur du 1er modèle disponible,
   puis on complète avec les suivants (AROME s'arrête à ~2 jours, ARPEGE à ~4 jours). */
const MODELS = {
  mf:     { name: "Météo-France", short: "AROME · ARPEGE", desc: "AROME 1,3 km sur 2 jours, puis ARPEGE jusqu'à 4 jours, puis ECMWF pour la suite. Recommandé en France.", chain: ["meteofrance_seamless", "best_match"] },
  arome:  { name: "AROME HD", short: "AROME 1,3 km", desc: "Le plus fin de Météo-France (1,3 km), idéal pour les orages et le relief. Horizon 2 jours, France uniquement.", chain: ["meteofrance_arome_france_hd", "meteofrance_arome_france", "meteofrance_seamless", "best_match"] },
  arpege: { name: "ARPEGE", short: "ARPEGE", desc: "Modèle de Météo-France sur l'Europe (≈11 km). Horizon 4 jours.", chain: ["meteofrance_arpege_europe", "best_match"] },
  ecmwf:  { name: "ECMWF", short: "ECMWF", desc: "Centre européen, la référence mondiale à moyen terme (≈25 km).", chain: ["ecmwf_ifs025", "best_match"] },
  icon:   { name: "ICON", short: "ICON · DWD", desc: "Modèle du service météo allemand (2 à 13 km).", chain: ["icon_seamless", "best_match"] },
  gfs:    { name: "GFS", short: "GFS · NOAA", desc: "Modèle américain de la NOAA (≈13 km).", chain: ["gfs_seamless", "best_match"] },
  auto:   { name: "Automatique", short: "Meilleur modèle", desc: "Open-Meteo choisit lui-même le meilleur modèle pour le lieu.", chain: ["best_match"] },
};
if (!MODELS[state.model]) state.model = "mf";

const COMPARE = [
  { id: "meteofrance_arome_france_hd", key: "arome", name: "AROME HD", sub: "Météo-France · 1,3 km", color: "#ff7a7a" },
  { id: "meteofrance_arpege_europe", key: "arpege", name: "ARPEGE", sub: "Météo-France · 11 km", color: "#ffbf5a" },
  { id: "ecmwf_ifs025", key: "ecmwf", name: "ECMWF", sub: "Europe · 25 km", color: "#5fd0ff" },
  { id: "icon_seamless", key: "icon", name: "ICON", sub: "Allemagne · 2–13 km", color: "#b892ff" },
  { id: "gfs_seamless", key: "gfs", name: "GFS", sub: "États-Unis · 13 km", color: "#7ee08a" },
];

// Fusionne les variables suffixées par modèle (ex. temperature_2m_meteofrance_seamless) selon l'ordre de priorité.
function mergeModels(sec, chain) {
  if (!sec) return sec;
  const out = {}, bases = new Set();
  for (const k in sec) {
    const m = chain.find((m) => k.endsWith("_" + m));
    if (m) bases.add(k.slice(0, -(m.length + 1)));
    else out[k] = sec[k];
  }
  for (const b of bases) {
    const arrs = chain.map((m) => sec[b + "_" + m]).filter((v) => v !== undefined);
    out[b] = Array.isArray(arrs[0])
      ? arrs[0].map((_, i) => { for (const a of arrs) if (a && a[i] != null) return a[i]; return null; })
      : arrs.find((v) => v != null) ?? null;
  }
  return out;
}

/* ---------------- Plages de France (point en mer + ville) ---------------- */
const BEACHES = [
  ["Manche", "Dunkerque", 51.05, 2.37, 51.08, 2.35], ["Manche", "Le Touquet", 50.52, 1.59, 50.52, 1.50],
  ["Manche", "Étretat", 49.71, 0.20, 49.73, 0.15], ["Manche", "Deauville", 49.36, 0.07, 49.39, 0.04],
  ["Manche", "Saint-Malo", 48.65, -2.02, 48.69, -2.06], ["Manche", "Perros-Guirec", 48.82, -3.45, 48.86, -3.45],
  ["Atlantique", "Brest", 48.39, -4.49, 48.33, -4.65], ["Atlantique", "Quiberon", 47.48, -3.12, 47.47, -3.18],
  ["Atlantique", "La Baule", 47.29, -2.39, 47.25, -2.43], ["Atlantique", "Les Sables-d'Olonne", 46.50, -1.78, 46.48, -1.83],
  ["Atlantique", "Île de Ré", 46.20, -1.42, 46.17, -1.52], ["Atlantique", "Royan", 45.62, -1.03, 45.60, -1.11],
  ["Atlantique", "Lacanau", 45.00, -1.20, 45.00, -1.26], ["Atlantique", "Arcachon", 44.66, -1.17, 44.59, -1.28],
  ["Atlantique", "Hossegor", 43.66, -1.44, 43.66, -1.49], ["Atlantique", "Biarritz", 43.48, -1.56, 43.49, -1.60],
  ["Méditerranée", "Collioure", 42.53, 3.08, 42.53, 3.13], ["Méditerranée", "Sète", 43.40, 3.70, 43.37, 3.72],
  ["Méditerranée", "La Grande-Motte", 43.56, 4.08, 43.52, 4.08], ["Méditerranée", "Marseille", 43.27, 5.37, 43.24, 5.32],
  ["Méditerranée", "Cassis", 43.21, 5.54, 43.19, 5.54], ["Méditerranée", "Saint-Tropez", 43.27, 6.64, 43.28, 6.71],
  ["Méditerranée", "Cannes", 43.55, 7.02, 43.52, 7.03], ["Méditerranée", "Nice", 43.70, 7.27, 43.67, 7.27],
  ["Méditerranée", "Menton", 43.78, 7.50, 43.76, 7.53],
  ["Corse", "Calvi", 42.57, 8.76, 42.58, 8.73], ["Corse", "Bastia", 42.70, 9.45, 42.70, 9.49],
  ["Corse", "Ajaccio", 41.92, 8.74, 41.89, 8.69], ["Corse", "Porto-Vecchio", 41.59, 9.28, 41.59, 9.34],
].map(([zone, name, lat, lon, slat, slon]) => ({ zone, name, lat, lon, slat, slon }));
let beachCache = { at: 0, data: null }, beachZone = "Toutes";

/* ---------------- Codes météo WMO ---------------- */
const WMO = {
  0: ["Ciel dégagé", "clear"], 1: ["Plutôt dégagé", "clear"], 2: ["Partiellement nuageux", "partly"], 3: ["Couvert", "cloudy"],
  45: ["Brouillard", "fog"], 48: ["Brouillard givrant", "fog"],
  51: ["Bruine légère", "drizzle"], 53: ["Bruine", "drizzle"], 55: ["Bruine dense", "drizzle"],
  56: ["Bruine verglaçante", "drizzle"], 57: ["Bruine verglaçante", "drizzle"],
  61: ["Pluie faible", "rain"], 63: ["Pluie", "rain"], 65: ["Forte pluie", "rain"],
  66: ["Pluie verglaçante", "rain"], 67: ["Pluie verglaçante", "rain"],
  71: ["Neige faible", "snow"], 73: ["Neige", "snow"], 75: ["Forte neige", "snow"], 77: ["Grains de neige", "snow"],
  80: ["Averses", "rain"], 81: ["Averses", "rain"], 82: ["Fortes averses", "rain"],
  85: ["Averses de neige", "snow"], 86: ["Fortes averses de neige", "snow"],
  95: ["Orage", "storm"], 96: ["Orage avec grêle", "storm"], 99: ["Orage avec grêle", "storm"],
};
const wmo = (c) => WMO[c] || ["—", "cloudy"];

/* ---------------- Icônes SVG (dégradés + animations) ---------------- */
let uid = 0;
function icon(code, isDay = 1, animated = true) {
  const kind = wmo(code)[1];
  const id = "i" + (++uid);
  const A = (cls) => (animated ? ` class="${cls}"` : "");
  const defs = `<defs>
    <radialGradient id="${id}s" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#fff3b0"/><stop offset=".55" stop-color="#ffc93c"/><stop offset="1" stop-color="#ff9a1f"/></radialGradient>
    <linearGradient id="${id}m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fffbe6"/><stop offset="1" stop-color="#c9cfe8"/></linearGradient>
    <linearGradient id="${id}c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d4deea"/></linearGradient>
    <linearGradient id="${id}d" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c3cedc"/><stop offset="1" stop-color="#8293a8"/></linearGradient>
    <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff176"/><stop offset="1" stop-color="#ffb300"/></linearGradient>
  </defs>`;
  const sun = (cx, cy, r) => `<g${A("spin-slow")}>${[0,45,90,135,180,225,270,315].map(a => {
      const rad = a * Math.PI / 180, r1 = r + 4, r2 = r + 9;
      return `<line x1="${cx + Math.cos(rad) * r1}" y1="${cy + Math.sin(rad) * r1}" x2="${cx + Math.cos(rad) * r2}" y2="${cy + Math.sin(rad) * r2}" stroke="#ffc93c" stroke-width="3" stroke-linecap="round"/>`;
    }).join("")}</g><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id}s)" stroke="none"/>`;
  const moon = (cx, cy, r) => `<path d="M${cx + r * .35} ${cy - r} A${r} ${r} 0 1 0 ${cx + r} ${cy + r * .45} A${r * .8} ${r * .8} 0 0 1 ${cx + r * .35} ${cy - r}Z" fill="url(#${id}m)" stroke="none"/>`;
  const cloud = (fill, tx = 0, ty = 0, s = 1) => `<g transform="translate(${tx} ${ty}) scale(${s})"${A("float")}><path d="M19 50a11 11 0 0 1-1.6-21.9A15 15 0 0 1 46 24.5 12.8 12.8 0 0 1 45.5 50Z" fill="url(#${id}${fill})" stroke="none"/></g>`;
  const drops = (n, color = "#6cc4ff") => {
    const xs = n === 2 ? [26, 38] : [22, 32, 42];
    return xs.map((x, i) => `<line${A("drop")} style="animation-delay:${i * .35}s" x1="${x}" y1="53" x2="${x - 3}" y2="60" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`).join("");
  };
  const flakes = () => [22, 32, 42].map((x, i) => `<circle${A("drop")} style="animation-delay:${i * .4}s" cx="${x}" cy="56" r="2.6" fill="#fff" stroke="none"/>`).join("");
  const body = {
    clear: isDay ? sun(32, 32, 13) : moon(30, 32, 15),
    partly: (isDay ? sun(24, 22, 10) : moon(24, 22, 11)) + cloud("c", 4, 6, .9),
    cloudy: cloud("d", -6, -4, .8) + cloud("c", 4, 4, .95),
    fog: cloud("c", 2, -6, .95) + `<g stroke="#e6edf5" stroke-width="3" stroke-linecap="round"><line x1="12" y1="50" x2="52" y2="50"/><line x1="18" y1="57" x2="46" y2="57"/></g>`,
    drizzle: cloud("c", 2, -6, .95) + drops(2, "#8fd3ff"),
    rain: cloud("d", 2, -6, .95) + drops(3),
    snow: cloud("c", 2, -6, .95) + flakes(),
    storm: cloud("d", 2, -8, .95) + `<path${A("flash")} d="M33 40 25 53h7l-3 10 11-15h-7l4-8Z" fill="url(#${id}b)" stroke="none"/>`,
  }[kind];
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${defs}${body}</svg>`;
}

const UI_ICONS = {
  umbrella: `<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 1 9 9H3a9 9 0 0 1 9-9Zm0 9v7a2 2 0 0 0 4 0"/></svg>`,
  sun: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  wind: `<svg viewBox="0 0 24 24"><path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/></svg>`,
  thermo: `<svg viewBox="0 0 24 24"><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0Z"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" style="width:64px;height:64px"><path d="M12 21s-7-7.5-7-12a7 7 0 0 1 14 0c0 4.5-7 12-7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>`,
  cloudOff: `<svg viewBox="0 0 24 24" style="width:64px;height:64px"><path d="M3 3l18 18M8 7a6 6 0 0 1 9.7 2A4.5 4.5 0 0 1 20 17M17 18H7a4 4 0 0 1-1.5-7.7"/></svg>`,
  x: `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
};

/* ---------------- Utilitaires ---------------- */
const fmtT = (v) => (v == null || isNaN(v) ? "--" : Math.round(v) + "°");
const pad = (n) => String(n).padStart(2, "0");
// Les heures renvoyées par l'API sont en heure locale du lieu : on les lit comme de l'UTC
// et on compare avec "maintenant" décalé du fuseau du lieu → tout reste cohérent.
const parseLocal = (s) => new Date(s + (s.length === 10 ? "T00:00Z" : "Z"));
const hhmm = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const DIRS = ["du nord", "du nord-est", "d'est", "du sud-est", "du sud", "du sud-ouest", "d'ouest", "du nord-ouest"];
const dirName = (deg) => DIRS[Math.round(deg / 45) % 8];
const placeKey = (p) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
const placeSub = (p) => [p.admin, p.country].filter((x, i, a) => x && a.indexOf(x) === i && x !== p.name).join(", ");

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}

function tempColor(t, unit) {
  const c = unit === "F" ? (t - 32) / 1.8 : t;
  const stops = [[-10, [120, 160, 255]], [0, [110, 200, 255]], [10, [120, 220, 190]], [18, [240, 220, 90]], [26, [255, 160, 70]], [34, [240, 80, 70]]];
  if (c <= stops[0][0]) return `rgb(${stops[0][1]})`;
  for (let i = 1; i < stops.length; i++) {
    if (c <= stops[i][0]) {
      const [a, ca] = stops[i - 1], [b, cb] = stops[i], k = (c - a) / (b - a);
      return `rgb(${ca.map((v, j) => Math.round(v + (cb[j] - v) * k))})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1]})`;
}

function skyFor(code, isDay, nowMin, riseMin, setMin) {
  const kind = wmo(code)[1];
  if (kind === "storm") return "storm";
  if (kind === "snow") return "snow";
  if (kind === "rain" || kind === "drizzle") return "rain";
  if (kind === "fog") return "fog";
  const golden = riseMin != null && (Math.abs(nowMin - riseMin) < 40 || Math.abs(nowMin - setMin) < 40);
  if (golden && kind !== "cloudy") return "sunset";
  if (kind === "cloudy") return isDay ? "cloudy-day" : "cloudy-night";
  return isDay ? "clear-day" : "clear-night";
}

/* ---------------- API ---------------- */
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function forecastURL(p) {
  const q = new URLSearchParams({
    latitude: p.lat, longitude: p.lon, timezone: "auto", forecast_days: 10,
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    hourly: "temperature_2m,weather_code,precipitation_probability,is_day,uv_index,visibility,dew_point_2m,relative_humidity_2m,apparent_temperature,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,precipitation_probability_max,uv_index_max,daylight_duration,wind_gusts_10m_max",
    models: MODELS[state.model].chain.join(","),
  });
  if (state.unit === "F") q.set("temperature_unit", "fahrenheit");
  return "https://api.open-meteo.com/v1/forecast?" + q;
}

async function searchCities(name) {
  const q = new URLSearchParams({ name, count: 8, language: "fr", format: "json" });
  const j = await fetchJSON("https://geocoding-api.open-meteo.com/v1/search?" + q);
  return (j.results || []).map((r) => ({ name: r.name, admin: r.admin1 || "", country: r.country || "", lat: r.latitude, lon: r.longitude }));
}

async function reverseGeocode(lat, lon) {
  try {
    const q = new URLSearchParams({ latitude: lat, longitude: lon, localityLanguage: "fr" });
    const j = await fetchJSON("https://api.bigdatacloud.net/data/reverse-geocode-client?" + q);
    return { name: j.city || j.locality || j.principalSubdivision || "Ma position", admin: j.principalSubdivision || "", country: j.countryName || "" };
  } catch {
    return { name: "Ma position", admin: "", country: "" };
  }
}

/* ---------------- Chargement ---------------- */
function showState(html) {
  $("state").innerHTML = html;
  ["hero", "insight-card", "hourly-card", "daily-card", "tiles", "models-card", "sea-card", "open-beaches"].forEach((id) => ($(id).hidden = true));
}

async function loadPlace(place, { quiet = false } = {}) {
  state.place = place;
  store.set("meteo.place", place);
  $("city-name").textContent = place.name;
  $("pin").style.display = place.gps ? "" : "none";
  updateFavBtn();
  if (!quiet) showState(`<div class="loader"></div>Chargement de la météo…`);
  try {
    const raw = await fetchJSON(forecastURL(place));
    const chain = MODELS[state.model].chain;
    const data = { ...raw, current: { ...raw.current }, hourly: mergeModels(raw.hourly, chain), daily: mergeModels(raw.daily, chain) };
    state.data = data;
    state.loadedAt = Date.now();
    render(data);
    loadCompare(place, data);
    loadSea(place);
  } catch (e) {
    showState(`<div class="big-ico">${UI_ICONS.cloudOff}</div>Impossible de récupérer la météo.<br>Vérifiez votre connexion.<br><button class="cta" id="retry">Réessayer</button>`);
    $("retry").onclick = () => loadPlace(place);
  }
}

function locate({ silent = false } = {}) {
  if (!("geolocation" in navigator)) {
    if (!silent) toast("Géolocalisation non disponible");
    return Promise.resolve(false);
  }
  if (!silent) toast("Recherche de votre position…");
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        const info = await reverseGeocode(lat, lon);
        await loadPlace({ ...info, lat, lon, gps: true });
        resolve(true);
      },
      () => {
        if (!silent) toast("Position refusée ou indisponible");
        resolve(false);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
    );
  });
}

/* ---------------- Rendu ---------------- */
function render(d) {
  const c = d.current, h = d.hourly, dl = d.daily;
  const off = d.utc_offset_seconds * 1000;
  const now = new Date(Date.now() + off); // "maintenant" en heure locale du lieu
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const rise = parseLocal(dl.sunrise[0]), set = parseLocal(dl.sunset[0]);
  const riseMin = rise.getUTCHours() * 60 + rise.getUTCMinutes();
  const setMin = set.getUTCHours() * 60 + set.getUTCMinutes();

  // Index de l'heure courante
  const hourTimes = h.time.map(parseLocal);
  let hi = hourTimes.findIndex((t) => t.getTime() > now.getTime()) - 1;
  if (hi < 0) hi = 0;

  // Si le modèle choisi ne couvre pas ce lieu pour "maintenant", on complète avec les données horaires fusionnées
  for (const k of ["temperature_2m", "relative_humidity_2m", "apparent_temperature", "weather_code", "pressure_msl", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "precipitation", "is_day"]) {
    if (c[k] == null && h[k]) c[k] = h[k][hi];
  }

  // Badge du modèle
  $("model-badge-txt").textContent = MODELS[state.model].short;

  // Ciel + effets
  const sky = skyFor(c.weather_code, c.is_day, nowMin, riseMin, setMin);
  document.body.dataset.sky = sky;
  fx.set(sky, wmo(c.weather_code)[1]);

  // En-tête
  $("local-time").textContent = `${DAYS[now.getUTCDay()]} ${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} · ${hhmm(now)}`;

  // Hero
  $("state").innerHTML = "";
  $("now-icon").innerHTML = icon(c.weather_code, c.is_day);
  $("now-temp").textContent = Math.round(c.temperature_2m);
  $("now-desc").textContent = wmo(c.weather_code)[0];
  $("now-hi").textContent = "Max " + fmtT(dl.temperature_2m_max[0]);
  $("now-lo").textContent = "Min " + fmtT(dl.temperature_2m_min[0]);
  $("now-feels").textContent = "Ressenti " + fmtT(c.apparent_temperature);

  // Résumé intelligent
  const ins = insight(d, hi, hourTimes);
  $("insight-icon").innerHTML = ins.icon;
  $("insight").textContent = ins.text;

  // Horaire (24 h + lever/coucher du soleil)
  const items = [];
  for (let i = hi; i < Math.min(hi + 25, h.time.length); i++) {
    const isNow = i === hi;
    items.push({ t: hourTimes[i], html: hourHTML(
      isNow ? "Maint." : pad(hourTimes[i].getUTCHours()) + "h",
      isNow ? icon(c.weather_code, c.is_day) : icon(h.weather_code[i], h.is_day[i], false),
      fmtT(isNow ? c.temperature_2m : h.temperature_2m[i]),
      h.precipitation_probability[i], isNow) });
  }
  const start = hourTimes[hi].getTime(), end = start + 24 * 3600e3;
  dl.sunrise.concat(dl.sunset).forEach((s, k) => {
    const t = parseLocal(s);
    if (t.getTime() > now.getTime() && t.getTime() < end) {
      const isRise = k < dl.sunrise.length;
      items.push({ t, html: `<div class="hour sun-ev"><span class="h-time">${hhmm(t)}</span><span class="h-icon">${sunEventIcon(isRise)}</span><span class="h-temp">${isRise ? "Lever" : "Coucher"}</span></div>` });
    }
  });
  items.sort((a, b) => a.t - b.t);
  $("hourly").innerHTML = items.map((x) => x.html).join("");
  $("hourly").scrollLeft = 0;

  // 10 jours
  const lo = Math.min(...dl.temperature_2m_min), hiT = Math.max(...dl.temperature_2m_max), span = Math.max(1, hiT - lo);
  $("daily").innerHTML = dl.time.map((t, i) => {
    const date = parseLocal(t);
    const name = i === 0 ? "Aujourd'hui" : DAYS[date.getUTCDay()].slice(0, 3) + ".";
    const a = dl.temperature_2m_min[i], b = dl.temperature_2m_max[i];
    const left = ((a - lo) / span) * 100, width = Math.max(4, ((b - a) / span) * 100);
    const grad = `linear-gradient(90deg, ${tempColor(a, state.unit)}, ${tempColor(b, state.unit)})`;
    const nowDot = i === 0 ? `<i style="left:${((c.temperature_2m - lo) / span) * 100}%"></i>` : "";
    const p = dl.precipitation_probability_max[i];
    return `<li class="day">
      <span class="d-name">${name}</span>
      <span class="d-icon">${icon(dl.weather_code[i], 1, false)}${p >= 30 ? `<span class="h-rain">${p}%</span>` : ""}</span>
      <span class="range"><span class="lo">${fmtT(a)}</span><span class="bar"><span style="left:${left}%;width:${width}%;background:${grad}"></span>${nowDot}</span><span class="hi">${fmtT(b)}</span></span>
    </li>`;
  }).join("");

  // Tuiles
  $("t-wind").textContent = Math.round(c.wind_speed_10m);
  $("needle").style.transform = `rotate(${c.wind_direction_10m + 180}deg)`;
  $("t-gust").textContent = `Vent ${dirName(c.wind_direction_10m)} · rafales ${Math.round(c.wind_gusts_10m)} km/h`;

  const uv = h.uv_index[hi] ?? 0;
  $("t-uv").textContent = Math.round(uv);
  $("t-uv-lbl").textContent = uv < 3 ? "Faible" : uv < 6 ? "Modéré" : uv < 8 ? "Élevé" : uv < 11 ? "Très élevé" : "Extrême";
  $("uv-dot").style.left = Math.min(100, (uv / 11) * 100) + "%";

  $("t-hum").textContent = c.relative_humidity_2m + " %";
  $("t-dew").textContent = `Point de rosée : ${fmtT(h.dew_point_2m[hi])}`;

  $("t-rain").textContent = (dl.precipitation_sum[0] ?? 0).toFixed(dl.precipitation_sum[0] < 10 ? 1 : 0).replace(".", ",") + " mm";
  const tomorrowRain = dl.precipitation_sum[1] ?? 0;
  $("t-rain-lbl").textContent = `Aujourd'hui (${dl.precipitation_probability_max[0] ?? 0} %). Demain : ${tomorrowRain.toFixed(1).replace(".", ",")} mm`;

  $("t-pres").textContent = Math.round(c.pressure_msl);
  const vis = (h.visibility[hi] ?? 0) / 1000;
  $("t-vis").textContent = (vis >= 10 ? Math.round(vis) : vis.toFixed(1).replace(".", ",")) + " km";
  $("t-vis-lbl").textContent = vis >= 10 ? "Visibilité parfaite" : vis >= 4 ? "Bonne visibilité" : vis >= 1 ? "Visibilité réduite" : "Très faible visibilité";

  $("t-sunrise").textContent = hhmm(rise);
  $("t-sunset").textContent = hhmm(set);
  const dlen = dl.daylight_duration[0] / 60;
  $("t-daylen").textContent = `${Math.floor(dlen / 60)} h ${pad(Math.round(dlen % 60))}`;
  drawSunArc(nowMin, riseMin, setMin);

  // Affichage avec animation
  ["hero", "insight-card", "hourly-card", "daily-card", "tiles", "open-beaches"].forEach((id) => ($(id).hidden = false));
  const sc = $("scroll");
  sc.classList.remove("reveal");
  void sc.offsetWidth;
  sc.classList.add("reveal");
}

function hourHTML(time, ico, temp, rain, isNow) {
  return `<div class="hour${isNow ? " now-h" : ""}"><span class="h-time">${time}</span><span class="h-icon">${ico}${rain >= 30 ? `<span class="h-rain">${rain}%</span>` : ""}</span><span class="h-temp">${temp}</span></div>`;
}

function sunEventIcon(rise) {
  return `<svg viewBox="0 0 64 64"><defs><radialGradient id="se${++uid}" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#fff3b0"/><stop offset="1" stop-color="#ff9a1f"/></radialGradient></defs>
    <path d="M18 42a14 14 0 0 1 28 0Z" fill="url(#se${uid})" stroke="none"/>
    <line x1="10" y1="44" x2="54" y2="44" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
    <path d="M32 ${rise ? "22 V10 M26 16 32 10 38 16" : "10 V22 M26 16 32 22 38 16"}" stroke="#ffd36b" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;
}

function drawSunArc(nowMin, riseMin, setMin) {
  let k = (nowMin - riseMin) / (setMin - riseMin);
  const dot = $("sun-dot"), fg = $("arc-fg");
  const up = k >= 0 && k <= 1;
  k = Math.max(0, Math.min(1, k));
  // Point sur la courbe de Bézier quadratique (10,100) (150,-40) (290,100)
  const x = (1 - k) ** 2 * 10 + 2 * (1 - k) * k * 150 + k * k * 290;
  const y = (1 - k) ** 2 * 100 + 2 * (1 - k) * k * -40 + k * k * 100;
  dot.setAttribute("cx", x);
  dot.setAttribute("cy", y);
  dot.style.opacity = up ? 1 : 0.35;
  const len = fg.getTotalLength();
  fg.style.strokeDasharray = len;
  fg.style.strokeDashoffset = len * (1 - k);
}

function insight(d, hi, times) {
  const c = d.current, h = d.hourly, dl = d.daily;
  const kind = wmo(c.weather_code)[1];
  const wet = (k) => ["rain", "drizzle", "storm", "snow"].includes(k);
  const hour = (i) => pad(times[i].getUTCHours()) + "h";

  if (wet(kind)) {
    for (let i = hi + 1; i < hi + 12 && i < h.time.length; i++) {
      if (h.precipitation_probability[i] < 30 && !wet(wmo(h.weather_code[i])[1])) {
        return { icon: UI_ICONS.umbrella, text: `${wmo(c.weather_code)[0]} en ce moment. Accalmie prévue vers ${hour(i)}.` };
      }
    }
    return { icon: UI_ICONS.umbrella, text: `${wmo(c.weather_code)[0]} en ce moment, et ça devrait durer. Gardez le parapluie à portée de main.` };
  }
  for (let i = hi + 1; i < hi + 12 && i < h.time.length; i++) {
    if (h.precipitation_probability[i] >= 50) {
      const k = wmo(h.weather_code[i])[1];
      const what = k === "snow" ? "De la neige" : k === "storm" ? "Un orage" : "De la pluie";
      return { icon: UI_ICONS.umbrella, text: `${what} est attendu${k === "snow" || k === "rain" || k === "drizzle" ? "e" : ""} vers ${hour(i)} (${h.precipitation_probability[i]} % de risque).` };
    }
  }
  if (dl.wind_gusts_10m_max[0] >= 60) return { icon: UI_ICONS.wind, text: `Journée venteuse : rafales jusqu'à ${Math.round(dl.wind_gusts_10m_max[0])} km/h.` };
  if (dl.uv_index_max[0] >= 7 && c.is_day) return { icon: UI_ICONS.sun, text: `UV élevé aujourd'hui (${Math.round(dl.uv_index_max[0])}). Lunettes et crème solaire conseillées.` };
  const diff = Math.round(dl.temperature_2m_max[1] - dl.temperature_2m_max[0]);
  if (Math.abs(diff) >= 3) return { icon: UI_ICONS.thermo, text: `Demain sera plus ${diff > 0 ? "chaud" : "frais"} : ${diff > 0 ? "+" : ""}${diff}° par rapport à aujourd'hui (max ${fmtT(dl.temperature_2m_max[1])}).` };
  return { icon: UI_ICONS.sparkle, text: `Temps calme : entre ${fmtT(dl.temperature_2m_min[0])} et ${fmtT(dl.temperature_2m_max[0])} aujourd'hui, pas de pluie prévue dans les prochaines heures.` };
}

/* ---------------- Comparaison des modèles ---------------- */
let compareSeq = 0;
async function loadCompare(place, main) {
  const seq = ++compareSeq;
  const q = new URLSearchParams({
    latitude: place.lat, longitude: place.lon, timezone: "auto", forecast_days: 3,
    hourly: "temperature_2m,precipitation", models: COMPARE.map((m) => m.id).join(","),
  });
  if (state.unit === "F") q.set("temperature_unit", "fahrenheit");
  try {
    const r = await fetchJSON("https://api.open-meteo.com/v1/forecast?" + q);
    if (seq !== compareSeq) return;
    renderCompare(r, main);
  } catch { $("models-card").hidden = true; }
}

function renderCompare(r, main) {
  const h = r.hourly, times = h.time.map(parseLocal);
  const now = new Date(Date.now() + r.utc_offset_seconds * 1000);
  let i0 = times.findIndex((t) => t.getTime() > now.getTime()) - 1;
  if (i0 < 0) i0 = 0;
  const N = 48, i1 = Math.min(times.length, i0 + N + 1);
  const series = COMPARE.map((m) => ({ ...m, t: h["temperature_2m_" + m.id] || [], p: h["precipitation_" + m.id] || [] }))
    .map((s) => ({ ...s, ok: s.t.slice(i0, i0 + 6).some((v) => v != null) }));
  const avail = series.filter((s) => s.ok);
  if (!avail.length) { $("models-card").hidden = true; return; }

  // Graphique
  const vals = avail.flatMap((s) => s.t.slice(i0, i1).filter((v) => v != null));
  let lo = Math.floor(Math.min(...vals)) - 1, hiV = Math.ceil(Math.max(...vals)) + 1;
  const W = 300, H = 130, X = (i) => ((i - i0) / N) * W, Y = (v) => H - ((v - lo) / (hiV - lo)) * H;
  const isSel = (s) => s.key === state.model || (state.model === "mf" && (s.key === "arome" || s.key === "arpege"));
  let svg = `<svg viewBox="0 -8 ${W} ${H + 26}" preserveAspectRatio="none">`;
  [lo, (lo + hiV) / 2, hiV].forEach((v) => {
    svg += `<line class="grid" x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}"/><text class="lbl" x="${W}" y="${Y(v) - 3}" text-anchor="end">${Math.round(v)}°</text>`;
  });
  for (let i = i0 + 1; i < i1; i++) {
    if (times[i].getUTCHours() === 0) {
      svg += `<line class="grid" x1="${X(i)}" x2="${X(i)}" y1="0" y2="${H}"/><text class="lbl" x="${X(i) + 4}" y="${H + 14}">${DAYS[times[i].getUTCDay()].slice(0, 3)}.</text>`;
    }
  }
  svg += `<text class="lbl" x="0" y="${H + 14}">Maint.</text>`;
  for (const s of [...avail].sort((a, b) => isSel(a) - isSel(b))) {
    let d = "", pen = false;
    for (let i = i0; i < i1; i++) {
      const v = s.t[i];
      if (v == null) { pen = false; continue; }
      d += `${pen ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`;
      pen = true;
    }
    svg += `<path class="ln${isSel(s) ? " sel" : ""}" stroke="${s.color}" d="${d}" vector-effect="non-scaling-stroke"/>`;
  }
  $("models-chart").innerHTML = svg + "</svg>";

  // Lignes : aujourd'hui / demain (max + cumul de pluie)
  const days = main.daily.time.slice(0, 2);
  const stat = (s, day) => {
    let mx = null, rain = 0, n = 0;
    h.time.forEach((t, i) => {
      if (!t.startsWith(day) || s.t[i] == null) return;
      mx = mx == null ? s.t[i] : Math.max(mx, s.t[i]);
      rain += s.p[i] || 0; n++;
    });
    return n < 12 ? null : { mx, rain };
  };
  const cell = (st, label) => `<span class="m-day"><small>${label}</small>${st ? `<b>${fmtT(st.mx)}</b> <span class="r">${st.rain.toFixed(1).replace(".", ",")} mm</span>` : "—"}</span>`;
  $("model-list").innerHTML = series.map((s) => `
    <li class="model-row${isSel(s) ? " sel" : ""}" data-model="${s.key}" ${s.ok ? "" : 'style="opacity:.45"'}>
      <span class="m-dot" style="background:${s.color}"></span>
      <span class="m-name"><b>${s.name}</b><small>${s.ok ? s.sub : "Hors zone pour ce lieu"}</small></span>
      ${cell(s.ok && stat(s, days[0]), "Auj.")}${cell(s.ok && stat(s, days[1]), "Demain")}
    </li>`).join("");
  $("models-card").hidden = false;
}

function setModel(key) {
  if (!MODELS[key] || key === state.model) return;
  state.model = key;
  store.set("meteo.model", key);
  toast("Prévisions : " + MODELS[key].name);
  if (state.place) loadPlace(state.place, { quiet: true });
}

function renderModelPick() {
  $("model-pick").innerHTML = Object.entries(MODELS).map(([k, m]) => `
    <li class="${k === state.model ? "sel" : ""}" data-model="${k}"><div><b>${m.name}</b><small>${m.desc}</small></div><span class="check"></span></li>`).join("");
}

/* ---------------- Mer : point marin le plus proche ---------------- */
const km = (a, b, c, d) => {
  const R = 6371, r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r;
  return Math.sqrt(x * x + y * y) * R;
};
const seaT = (v) => (v == null ? "--" : Math.round(state.unit === "F" ? v * 1.8 + 32 : v) + "°");
let seaSeq = 0;

async function loadSea(place) {
  const seq = ++seaSeq;
  $("sea-card").hidden = true;
  // On sonde le lieu et deux anneaux autour (~10 et ~25 km) pour trouver la mer la plus proche
  const pts = [[0, 0]];
  for (const r of [0.1, 0.22]) for (let a = 0; a < 360; a += 45) pts.push([Math.sin(a * Math.PI / 180) * r, Math.cos(a * Math.PI / 180) * r * 1.4]);
  const lats = pts.map((p) => (place.lat + p[0]).toFixed(3)), lons = pts.map((p) => (place.lon + p[1]).toFixed(3));
  try {
    let res = await fetchJSON("https://marine-api.open-meteo.com/v1/marine?" + new URLSearchParams({
      latitude: lats.join(","), longitude: lons.join(","), current: "sea_surface_temperature", timezone: "auto",
    }));
    if (!Array.isArray(res)) res = [res];
    let best = null;
    res.forEach((r, i) => {
      if (r.current?.sea_surface_temperature == null) return;
      const dist = km(place.lat, place.lon, +lats[i], +lons[i]);
      if (!best || dist < best.dist) best = { lat: +lats[i], lon: +lons[i], dist };
    });
    if (!best || seq !== seaSeq) return;
    const m = await fetchJSON("https://marine-api.open-meteo.com/v1/marine?" + new URLSearchParams({
      latitude: best.lat, longitude: best.lon, timezone: "auto", forecast_days: 6,
      current: "sea_surface_temperature,wave_height,wave_direction,wave_period",
      hourly: "sea_surface_temperature", daily: "wave_height_max",
    }));
    if (seq !== seaSeq) return;
    const c = m.current;
    $("sea-where").textContent = best.dist > 3 ? `· à ${Math.round(best.dist)} km` : "";
    $("sea-temp").textContent = seaT(c.sea_surface_temperature);
    const t = Math.round(c.sea_surface_temperature);
    $("sea-lbl").textContent = t >= 24 ? "Eau chaude, baignade idéale" : t >= 20 ? "Eau agréable" : t >= 17 ? "Eau fraîche" : "Eau froide";
    $("sea-wave").textContent = c.wave_height == null ? "--" : c.wave_height.toFixed(1).replace(".", ",") + " m";
    $("sea-period").textContent = c.wave_period == null ? "--" : Math.round(c.wave_period) + " s";
    $("sea-dir").textContent = c.wave_direction == null ? "--" : ["N", "NE", "E", "SE", "S", "SO", "O", "NO"][Math.round(c.wave_direction / 45) % 8];
    // Tendance : température de l'eau à midi pour les prochains jours
    const hh = m.hourly, out = [];
    hh.time.forEach((t, i) => { if (t.endsWith("T12:00") && hh.sea_surface_temperature[i] != null) out.push([parseLocal(t), hh.sea_surface_temperature[i]]); });
    $("sea-days").innerHTML = out.slice(0, 6).map(([d, v], i) => `<div>${i === 0 ? "Auj." : DAYS[d.getUTCDay()].slice(0, 3) + "."}<b>${seaT(v)}</b></div>`).join("");
    $("sea-card").hidden = false;
  } catch {}
}

/* ---------------- Plages de France ---------------- */
async function renderBeaches() {
  const zones = ["Toutes", "Manche", "Atlantique", "Méditerranée", "Corse"];
  $("beach-seg").innerHTML = zones.map((z) => `<button class="${z === beachZone ? "on" : ""}" data-zone="${z}">${z}</button>`).join("");
  const list = BEACHES.filter((b) => beachZone === "Toutes" || b.zone === beachZone);
  const draw = () => {
    const d = beachCache.data;
    $("beach-list").innerHTML = list.map((b) => {
      const c = d?.[BEACHES.indexOf(b)]?.current;
      const t = c?.sea_surface_temperature;
      const wave = c?.wave_height != null ? `Vagues ${c.wave_height.toFixed(1).replace(".", ",")} m` : "";
      return `<li class="beach" data-b="${BEACHES.indexOf(b)}"><div><b>${b.name}</b><small>${b.zone}</small></div><span class="wv">${wave}</span>
        <span class="wt" style="background:${t == null ? "rgba(255,255,255,.12)" : tempColor(t, "C")};${t == null ? "color:#fff" : ""}">${d ? seaT(t) : "…"}</span></li>`;
    }).join("");
  };
  draw();
  if (!beachCache.data || Date.now() - beachCache.at > 30 * 60e3) {
    try {
      let res = await fetchJSON("https://marine-api.open-meteo.com/v1/marine?" + new URLSearchParams({
        latitude: BEACHES.map((b) => b.slat).join(","), longitude: BEACHES.map((b) => b.slon).join(","),
        current: "sea_surface_temperature,wave_height", timezone: "auto",
      }));
      beachCache = { at: Date.now(), data: Array.isArray(res) ? res : [res] };
      draw();
    } catch { toast("Impossible de charger les plages"); }
  }
}

/* ---------------- Effets animés (pluie, neige, étoiles) ---------------- */
const fx = (() => {
  const cv = $("fx"), ctx = cv.getContext("2d");
  let parts = [], mode = "", raf = 0, W = 0, H = 0, dpr = 1;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function size() {
    dpr = Math.min(2, devicePixelRatio || 1);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function spawn() {
    parts = [];
    const n = mode === "rain" ? 110 : mode === "snow" ? 70 : mode === "stars" ? 90 : 0;
    for (let i = 0; i < n; i++) {
      parts.push({ x: Math.random() * W, y: Math.random() * H, s: Math.random(), p: Math.random() * Math.PI * 2 });
    }
  }
  function frame(t) {
    ctx.clearRect(0, 0, W, H);
    for (const q of parts) {
      if (mode === "rain") {
        q.y += 9 + q.s * 8; q.x -= 1.5;
        if (q.y > H) { q.y = -20; q.x = Math.random() * W; }
        ctx.strokeStyle = `rgba(190,220,255,${0.15 + q.s * 0.3})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - 2, q.y + 10 + q.s * 8); ctx.stroke();
      } else if (mode === "snow") {
        q.y += 0.6 + q.s * 1.2; q.x += Math.sin(t / 1200 + q.p) * 0.5;
        if (q.y > H) { q.y = -5; q.x = Math.random() * W; }
        ctx.fillStyle = `rgba(255,255,255,${0.5 + q.s * 0.5})`;
        ctx.beginPath(); ctx.arc(q.x, q.y, 1.2 + q.s * 2.3, 0, 7); ctx.fill();
      } else if (mode === "stars") {
        if (q.y > H * 0.6) continue;
        ctx.fillStyle = `rgba(255,255,255,${0.25 + 0.6 * Math.abs(Math.sin(t / 1500 + q.p)) * q.s})`;
        ctx.beginPath(); ctx.arc(q.x, q.y, 0.6 + q.s * 1.1, 0, 7); ctx.fill();
      }
    }
    raf = requestAnimationFrame(frame);
  }
  function set(sky, kind) {
    const m = kind === "snow" ? "snow" : (kind === "rain" || kind === "drizzle" || kind === "storm") ? "rain" : sky === "clear-night" ? "stars" : "";
    if (m === mode) return;
    mode = m;
    cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, W, H);
    if (!m || reduce) return;
    size(); spawn(); raf = requestAnimationFrame(frame);
  }
  addEventListener("resize", () => { if (mode) { size(); spawn(); } });
  return { set };
})();

/* ---------------- Favoris & feuille "Mes villes" ---------------- */
const isFav = () => state.place && state.cities.some((c) => placeKey(c) === placeKey(state.place));

function updateFavBtn() {
  const on = isFav();
  $("fav-btn").classList.toggle("on", on);
  $("fav-btn").setAttribute("aria-label", on ? "Retirer des favoris" : "Ajouter aux favoris");
}

function toggleFav() {
  if (!state.place) return;
  if (isFav()) {
    state.cities = state.cities.filter((c) => placeKey(c) !== placeKey(state.place));
    toast("Retirée de vos villes");
  } else {
    const { gps, ...p } = state.place;
    state.cities.push(p);
    toast("Ajoutée à vos villes ★");
    $("fav-btn").classList.remove("pop"); void $("fav-btn").offsetWidth; $("fav-btn").classList.add("pop");
  }
  store.set("meteo.cities", state.cities);
  updateFavBtn();
}

const SKY_CARD = {
  "clear-day": "linear-gradient(135deg,#2a7be4,#69b1f3)", "cloudy-day": "linear-gradient(135deg,#557395,#8aa2bd)",
  rain: "linear-gradient(135deg,#2a3c52,#4f6780)", storm: "linear-gradient(135deg,#1c1f36,#454a70)",
  snow: "linear-gradient(135deg,#6c89a8,#a9bfd5)", fog: "linear-gradient(135deg,#66707a,#9aa3ac)",
  "clear-night": "linear-gradient(135deg,#0c1735,#2a3f75)", "cloudy-night": "linear-gradient(135deg,#151c2b,#3a465c)",
  sunset: "linear-gradient(135deg,#4a3a8a,#e08a6e)",
};

async function renderCityList() {
  const list = $("city-list");
  if (!state.cities.length) {
    list.innerHTML = `<li class="city-empty">Aucune ville enregistrée.<br>Recherchez une ville puis touchez ★ pour l'ajouter ici.</li>`;
    return;
  }
  const cur = state.place ? placeKey(state.place) : "";
  list.innerHTML = state.cities.map((p, i) => `
    <li class="city${placeKey(p) === cur ? " active" : ""}" data-i="${i}">
      <div class="c-main"><div class="c-title">${esc(p.name)}</div><div class="c-sub" data-sub>${esc(placeSub(p) || " ")}</div></div>
      <div class="c-ico" data-ico></div><div class="c-temp" data-temp>--</div>
      <button class="c-del" data-del="${i}" aria-label="Supprimer">${UI_ICONS.x}</button>
    </li>`).join("");

  // Météo actuelle de toutes les villes en une seule requête
  try {
    const q = new URLSearchParams({
      latitude: state.cities.map((c) => c.lat).join(","), longitude: state.cities.map((c) => c.lon).join(","),
      current: "temperature_2m,weather_code,is_day", daily: "temperature_2m_max,temperature_2m_min", timezone: "auto", forecast_days: 1,
    });
    if (state.unit === "F") q.set("temperature_unit", "fahrenheit");
    let res = await fetchJSON("https://api.open-meteo.com/v1/forecast?" + q);
    if (!Array.isArray(res)) res = [res];
    res.forEach((r, i) => {
      const li = list.querySelector(`[data-i="${i}"]`);
      if (!li) return;
      const now = new Date(Date.now() + r.utc_offset_seconds * 1000);
      li.style.setProperty("--card-sky", SKY_CARD[skyFor(r.current.weather_code, r.current.is_day)]);
      li.querySelector("[data-ico]").innerHTML = icon(r.current.weather_code, r.current.is_day, false);
      li.querySelector("[data-temp]").textContent = fmtT(r.current.temperature_2m);
      li.querySelector("[data-sub]").textContent = `${hhmm(now)} · ${wmo(r.current.weather_code)[0]} · ${fmtT(r.daily.temperature_2m_max[0])} / ${fmtT(r.daily.temperature_2m_min[0])}`;
    });
  } catch {}
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function showSheet(id) {
  $("sheet-backdrop").hidden = false;
  $(id).classList.add("open");
  $(id).setAttribute("aria-hidden", "false");
}
function openSheet() {
  showSheet("sheet");
  $("search-input").value = "";
  $("suggestions").innerHTML = "";
  renderCityList();
}
function closeSheet() {
  document.querySelectorAll(".sheet.open").forEach((s) => { s.classList.remove("open"); s.setAttribute("aria-hidden", "true"); });
  $("sheet-backdrop").hidden = true;
  $("search-input").blur();
}

/* ---------------- Recherche ---------------- */
let searchTimer = 0, searchSeq = 0, results = [];
$("search-input").addEventListener("input", (e) => {
  const v = e.target.value.trim();
  clearTimeout(searchTimer);
  if (v.length < 2) { $("suggestions").innerHTML = ""; results = []; return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const r = await searchCities(v);
      if (seq !== searchSeq) return;
      results = r;
      $("suggestions").innerHTML = r.length
        ? r.map((p, i) => `<li data-r="${i}"><b>${esc(p.name)}</b><small>${esc(placeSub(p))}</small></li>`).join("")
        : `<li class="city-empty" style="border:none">Aucune ville trouvée</li>`;
    } catch { $("suggestions").innerHTML = ""; }
  }, 250);
});
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (results[0]) { closeSheet(); loadPlace(results[0]); }
});
$("suggestions").addEventListener("click", (e) => {
  const li = e.target.closest("[data-r]");
  if (!li) return;
  closeSheet();
  loadPlace(results[+li.dataset.r]);
});

/* ---------------- Événements ---------------- */
$("open-cities").addEventListener("click", openSheet);
$("close-cities").addEventListener("click", closeSheet);
$("sheet-backdrop").addEventListener("click", closeSheet);
$("fav-btn").addEventListener("click", toggleFav);
$("locate-btn").addEventListener("click", async () => { closeSheet(); await locate(); });
$("city-list").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    e.stopPropagation();
    state.cities.splice(+del.dataset.del, 1);
    store.set("meteo.cities", state.cities);
    updateFavBtn();
    renderCityList();
    return;
  }
  const li = e.target.closest("[data-i]");
  if (li) { closeSheet(); loadPlace(state.cities[+li.dataset.i]); }
});
$("unit-btn").addEventListener("click", () => {
  state.unit = state.unit === "C" ? "F" : "C";
  store.set("meteo.unit", state.unit);
  updateUnitBtn();
  if (state.place) loadPlace(state.place, { quiet: true });
});
function updateUnitBtn() { $("unit-btn").textContent = state.unit === "C" ? "Passer en °F" : "Passer en °C"; }

$("model-badge").addEventListener("click", () => { renderModelPick(); showSheet("model-sheet"); });
$("close-model").addEventListener("click", closeSheet);
$("model-pick").addEventListener("click", (e) => {
  const li = e.target.closest("[data-model]");
  if (!li) return;
  closeSheet();
  setModel(li.dataset.model);
});
$("model-list").addEventListener("click", (e) => {
  const li = e.target.closest("[data-model]");
  if (li && li.style.opacity === "") setModel(li.dataset.model);
});
$("open-beaches").addEventListener("click", () => { showSheet("beach-sheet"); renderBeaches(); });
$("close-beaches").addEventListener("click", closeSheet);
$("beach-seg").addEventListener("click", (e) => {
  const b = e.target.closest("[data-zone]");
  if (b) { beachZone = b.dataset.zone; renderBeaches(); }
});
$("beach-list").addEventListener("click", (e) => {
  const li = e.target.closest("[data-b]");
  if (!li) return;
  const b = BEACHES[+li.dataset.b];
  closeSheet();
  loadPlace({ name: b.name, admin: b.zone, country: "France", lat: b.lat, lon: b.lon });
});

// Glisser une feuille vers le bas pour la fermer
document.querySelectorAll(".sheet").forEach((sh) => {
  let y0 = null, dy = 0;
  sh.addEventListener("touchstart", (e) => {
    const sc = e.target.closest(".city-list, .beach-list, .model-pick");
    if (sc && sc.scrollTop > 0) return;
    y0 = e.touches[0].clientY; dy = 0; sh.style.transition = "none";
  }, { passive: true });
  sh.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    sh.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  sh.addEventListener("touchend", () => {
    if (y0 == null) return;
    sh.style.transition = ""; sh.style.transform = "";
    if (dy > 120) closeSheet();
    y0 = null;
  });
});

// Actualiser au retour dans l'appli si les données ont plus de 10 min
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.place && Date.now() - state.loadedAt > 10 * 60e3) {
    loadPlace(state.place, { quiet: true });
  }
});

/* ---------------- Démarrage ---------------- */
(async function init() {
  updateUnitBtn();
  if (state.place) {
    loadPlace(state.place);
  } else {
    showState(`<div class="loader"></div>Localisation en cours…`);
    const ok = await locate({ silent: true });
    if (!ok) loadPlace(FALLBACK);
  }
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
