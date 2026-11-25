// ====== أسعار الوقود المرجعية - تحقق منها من موقع أرامكو قبل الاعتماد عليها ======
const SAR_PRICES = { p91: 2.18, p95: 2.33, diesel: 1.79 };
const PRICES_PERIOD = "نوفمبر 2026";

// ====== نقاط الطريق (lng, lat) ======
const ROUTES = {
  makkah: {
    title: "مكة المكرمة",
    waypoints: [[46.6753, 24.7136], [42.2, 22.9], [40.41, 21.27], [39.8262, 21.4225]]
  },
  qassim: {
    title: "القصيم",
    waypoints: [[46.6753, 24.7136], [45.2, 26.3], [43.98, 26.33]]
  },
  dammam: {
    title: "الدمام",
    waypoints: [[46.6753, 24.7136], [47.27, 24.15], [49.58, 25.38], [50.0888, 26.4207]]
  }
};

const SEARCH_RADIUS_M = 8000;
const SAMPLE_STEP_KM = 50;
const MAX_DIST_TO_ROUTE_M = 3000;
const POI_RADIUS_M = 500;
const GAP_WARNING_KM = 120;
const LOCATE_MAX_OFF_ROUTE_KM = 30;
const FETCH_TIMEOUT_MS = 30000;
const OVERPASS_TIMEOUT_MS = 90000;

const OVERPASS_URLS = [
"https://overpass-api.de/api/interpreter",
"https://overpass.kumi.systems/api/interpreter"
];



// الخدمات: [أيقونة، اسم]
const SERVICE_META = {
  toilets: ["i-wc", "دورات مياه"],
  grocery: ["i-cart", "بقالة"],
  carwash: ["i-car", "غسيل سيارات"],
  workshop: ["i-wrench", "ورشة"],
  mosque: ["i-mosque", "مسجد"],
  restaurant: ["i-food", "مطعم"],
  cafe: ["i-cafe", "مقهى"],
  atm: ["i-atm", "صراف"]
};

const CAT_NAMES = { mosque: "مسجد", restaurant: "مطعم", cafe: "مقهى" };

const POI_FILTER = '["amenity"~"^(fuel|restaurant|fast_food|cafe|place_of_worship|toilets|atm|car_wash|car_repair)$"]';
const SHOP_FILTER = '["shop"~"^(convenience|supermarket|grocery|car_repair)$"]';
const MOSQUE_FILTER = '["building"="mosque"]';

// ====== عناصر الصفحة ======
let currentRoute = "makkah";
const routeSelect = document.getElementById("routeSelect");
const currentKmInput = document.getElementById("currentKm");
const fuelChecks = document.querySelectorAll(".fuel-filter");
const svcChecks = document.querySelectorAll(".svc-filter");
const searchBtn = document.getElementById("searchBtn");
const locateBtn = document.getElementById("locateBtn");
const locateHint = document.getElementById("locateHint");
const list = document.getElementById("list");
const statusBox = document.getElementById("status");
const termsDialog = document.getElementById("terms");

// ====== الخريطة ======
const map = L.map("map").setView([24.7, 46.7], 7);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap"
}).addTo(map);
const markersLayer = L.layerGroup().addTo(map);
const routeLine = L.polyline([], { color: "#145A38", weight: 4 }).addTo(map);

// ====== أدوات ======
function haversine(lat1, lon1, lat2, lon2) { // بالكيلومتر
  const R = 6371, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function fetchWithTimeout(url, options = {}, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e.name === "AbortError") throw new Error("انتهت مهلة الاتصال");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function setStatus(type, text) {
  statusBox.className = "status " + type;
  statusBox.textContent = text;
}

// ====== مسار الطريق من OSRM ======
const routeCache = {};
let userStartLocation = null;

async function getRoad(routeKey) {
  if (!userStartLocation && routeCache[routeKey]) {
return routeCache[routeKey];
}

  const points = ROUTES[routeKey].waypoints;

const start = userStartLocation || points[0];

const wp = [
start,
...points.slice(1)
].map(p => p.join(",")).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${wp}?overview=full&geometries=geojson`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error("خدمة المسارات HTTP " + res.status);
  const data = await res.json();
  if (data.code !== "Ok") throw new Error("تعذر حساب مسار الطريق");

  const r = data.routes[0];
  const coords = r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));

  // المسافة التراكمية على الطريق من الرياض بالكيلومتر
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversine(coords[i - 1].lat, coords[i - 1].lng, coords[i].lat, coords[i].lng));
  }

  // نقاط عينة على الطريق للبحث
  const samples = [coords[0]];
  let next = SAMPLE_STEP_KM;
  for (let i = 1; i < coords.length; i++) {
    if (cum[i] >= next) { samples.push(coords[i]); next += SAMPLE_STEP_KM; }
  }
  samples.push(coords[coords.length - 1]);

  routeCache[routeKey] = { coords, cum, samples, totalKm: Math.round(r.distance / 1000) };
  return routeCache[routeKey];
}

function nearestOnRoute(road, lat, lng) {
  let best = { d: Infinity, i: 0 };
  road.coords.forEach((p, i) => {
    const d = haversine(lat, lng, p.lat, p.lng);
    if (d < best.d) best = { d, i };
  });
  return best;
}

// ====== تصنيف العناصر من OSM ======
function classifyPoi(t) {
  const cats = [];
  const amenity = t.amenity, shop = t.shop;
  if (amenity === "fuel") cats.push("fuel");
  if (amenity === "restaurant" || amenity === "fast_food") cats.push("restaurant");
  if (amenity === "cafe") cats.push("cafe");
  if ((amenity === "place_of_worship" && (t.religion === "muslim" || !t.religion)) || t.building === "mosque") cats.push("mosque");
  if (["convenience", "supermarket", "grocery"].includes(shop)) cats.push("grocery");
  if (amenity === "car_wash") cats.push("carwash");
  if (amenity === "car_repair" || shop === "car_repair") cats.push("workshop");
  if (amenity === "toilets") cats.push("toilets");
  if (amenity === "atm") cats.push("atm");
  return cats;
}

// ====== Overpass مع خادم احتياطي ======
async function runOverpass(query) {
  let lastErr = null;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query)
      }, OVERPASS_TIMEOUT_MS);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("تعذر الاتصال بـ Overpass (" + (lastErr ? lastErr.message : "") + ")");
}

// ====== جلب المحطات والخدمات من OpenStreetMap ======
const stationCache = {};

async function loadStations(routeKey) {
  if (stationCache[routeKey]) return stationCache[routeKey];

  const road = await getRoad(routeKey);

const path = road.samples
  .map(p => p.lat + "," + p.lng)
  .join(",");

const a = "(around:" + SEARCH_RADIUS_M + "," + path + ")";

const query = "[out:json][timeout:60];" +
  'nwr' + a + '["amenity"="fuel"]->.fuel;' +
  "(.fuel;" +
  "nwr(around.fuel:500)" + POI_FILTER + ";" +
  "nwr(around.fuel:500)" + SHOP_FILTER + ";" +
  "nwr(around.fuel:500)" + MOSQUE_FILTER + ";" +
  ");out center tags;";

const data = await runOverpass(query);

  const pois = [], seen = new Set();
  data.elements.forEach(el => {
    const key = el.type + el.id;
    if (seen.has(key)) return;
    seen.add(key);
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (lat == null || lng == null) return;
    const tags = el.tags || {};
    const cats = classifyPoi(tags);
    if (cats.length) pois.push({ lat, lng, tags, cats });
  });

  const fuelPois = pois.filter(p => p.cats.includes("fuel"));
  const yn = v => v === "yes" ? true : v === "no" ? false : null; // null = غير مسجل
  const found = cond => (cond ? true : null); // true = مرصود، null = غير مؤكد

  const stations = [];
  fuelPois.forEach(f => {
    const near = nearestOnRoute(road, f.lat, f.lng);
    console.log(f.tags.name, near.i, road.cum[near.i], near.d);
    if (near.d * 1000 > MAX_DIST_TO_ROUTE_M) return;

    const t = f.tags;
    const nearby = pois.filter(p =>
      p !== f && haversine(f.lat, f.lng, p.lat, p.lng) * 1000 <= POI_RADIUS_M
    );
    const has = cat => nearby.some(p => p.cats.includes(cat));

    const nearbyItems = ["mosque", "restaurant", "cafe"].flatMap(cat => {
      const names = [...new Set(nearby.filter(p => p.cats.includes(cat)).map(p => p.tags.name || null))];
      return names.slice(0, 3).map(n => ({ label: CAT_NAMES[cat], name: n }));
    });

    stations.push({
      name: t["name:ar"] || t["brand:ar"] || t["operator:ar"] || t.name || t.brand || t.operator || t["name:en"] || t["brand:en"] || t["operator:en"] || "محطة وقود غير مسماة",
brand: t["brand:ar"] || t.brand || t["operator:ar"] || t.operator || "غير معروف",
      lat: f.lat,
      lng: f.lng,
      km: Number(road.cum[near.i].toFixed(2)),
      hours: t.opening_hours || "غير معروف",
      fuels: {
        p91: yn(t["fuel:octane_91"]),
        p95: yn(t["fuel:octane_95"]),
        diesel: yn(t["fuel:diesel"])
      },
      services: {
        toilets: found(has("toilets") || t.toilets === "yes"),
        grocery: found(has("grocery") || ["convenience", "supermarket", "grocery"].includes(t.shop)),
        carwash: found(has("carwash") || t.car_wash === "yes"),
        workshop: found(has("workshop")),
        mosque: found(has("mosque")),
        restaurant: found(has("restaurant")),
        cafe: found(has("cafe")),
        atm: found(has("atm") || t.atm === "yes")
      },
      nearby: nearbyItems
    });
  });

  stations.sort((a, b) => a.km - b.km);
  stationCache[routeKey] = { stations, totalKm: road.totalKm };
  return stationCache[routeKey];
}

// ====== اختيار الوجهة والبحث ======
routeSelect.addEventListener("change", () => {
  currentRoute = routeSelect.value;
  refresh();
});

searchBtn.addEventListener("click", refresh);

// ====== الكيلومتر المحفوظ ======
const savedKm = localStorage.getItem("darbakKm");
if (savedKm) currentKmInput.value = savedKm;

currentKmInput.addEventListener("input", () => {
  localStorage.setItem("darbakKm", currentKmInput.value);
  render();
});

// ====== تحديد الموقع الحالي وتحويله إلى كيلومتر على الطريق ======
function setLocateHint(text, isError = false) {
  locateHint.textContent = text;
  locateHint.style.color = isError ? "#8a2b1f" : "";
}

locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    setLocateHint("المتصفح لا يدعم تحديد الموقع. أدخل الكيلومتر يدوياً.", true);
    return;
  }
  locateBtn.disabled = true;
  setLocateHint("جاري تحديد موقعك...");

  navigator.geolocation.getCurrentPosition(async pos => {
    try {
        userStartLocation = [
pos.coords.longitude,
pos.coords.latitude
        ];
        if (window.userLocationMarker) {
map.removeLayer(window.userLocationMarker);
}

window.userLocationMarker = L.circleMarker(
[pos.coords.latitude, pos.coords.longitude],
{
radius: 9,
color: "#ffffff",
weight: 3,
fillColor: "#1683ff",
fillOpacity: 1
}
).addTo(map);

window.userLocationMarker.bindPopup(" موقعك الحالي");

map.setView(
[pos.coords.latitude, pos.coords.longitude],
14
);
delete routeCache[currentRoute];
await refresh();
      const road = await getRoad(currentRoute);
      const near = nearestOnRoute(road, pos.coords.latitude, pos.coords.longitude);
      if (near.d > LOCATE_MAX_OFF_ROUTE_KM) {
        setLocateHint(`موقعك بعيد عن طريق ${ROUTES[currentRoute].title} (أكثر من ${LOCATE_MAX_OFF_ROUTE_KM} كم). أدخل الكيلومتر يدوياً.`, true);
      } else {
        const km = Math.round(road.cum[near.i]);
        currentKmInput.value = km;
        localStorage.setItem("darbakKm", km);
        setLocateHint(`تم تقدير موقعك على الطريق: ${km} كم من الرياض`);
        render();
      }
    } catch (e) {
      setLocateHint("تعذر تحميل الطريق: " + e.message, true);
    } finally {
      locateBtn.disabled = false;
    }
  }, err => {
    const msg = err.code === 1 ? "تم رفض إذن تحديد الموقع." : "تعذر تحديد موقعك. أدخل الكيلومتر يدوياً.";
    setLocateHint(msg, true);
    locateBtn.disabled = false;
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
});

// ====== الشروط والأحكام ======
document.querySelectorAll(".open-terms").forEach(btn =>
  btn.addEventListener("click", () => termsDialog.showModal())
);
document.getElementById("closeTerms").addEventListener("click", () => termsDialog.close());
termsDialog.addEventListener("click", e => {
  if (e.target === termsDialog) termsDialog.close();
});

fuelChecks.forEach(c => c.addEventListener("change", render));
svcChecks.forEach(c => c.addEventListener("change", render));

// ====== التحميل ثم العرض ======
let allStations = [];
let routeTotal = 0;
let requestId = 0;

async function refresh() {
  const id = ++requestId;
  searchBtn.disabled = true;
  list.innerHTML = "";
  markersLayer.clearLayers();
  setStatus("loading", "جاري حساب الطريق وتحميل المحطات والخدمات...");

  try {
    const road = await getRoad(currentRoute);
    if (id !== requestId) return;
    routeLine.setLatLngs(road.coords.map(p => [p.lat, p.lng]));
    map.fitBounds(routeLine.getBounds(), { padding: [20, 20] });

    const data = await loadStations(currentRoute);
    if (id !== requestId) return;
    allStations = data.stations;
    routeTotal = data.totalKm;

    if (allStations.length === 0) {
      setStatus("error", "ما لقيت محطات وقود مسجلة في OpenStreetMap على هذا الطريق.");
    } else {
      setStatus("ok", `تم العثور على ${allStations.length} محطة وقود حقيقية على طريق ${ROUTES[currentRoute].title}`);
    }
    render();
  } catch (err) {
    if (id !== requestId) return;
    allStations = [];
    routeTotal = 0;
    setStatus("error", "تعذر تحميل البيانات. تأكد من الإنترنت ثم اضغط «ابحث عن المحطات» مرة ثانية. (" + err.message + ")");
    render();
  } finally {
    if (id === requestId) searchBtn.disabled = false;
  }
}

// ====== الفلترة والعرض ======
function render() {
  const startKm = Math.max(0, Number(currentKmInput.value) || 0);
  const selectedFuels = [...fuelChecks].filter(c => c.checked).map(c => c.value);
  const selectedServices = [...svcChecks].filter(c => c.checked).map(c => c.value);

  // المحطات أمامك فقط، والمتجاوزة تُستبعد
  const ahead = allStations.filter(s => s.km >= startKm);
  let prevKm = startKm;
  const withGap = ahead.map(s => {
    const gap = s.km - prevKm;
    prevKm = s.km;
    return { ...s, gap };
  });

  // الوقود: تظهر إذا كان متوفراً أو غير مسجل. الخدمات: تظهر فقط إذا رُصدت فعلاً
  const shown = withGap.filter(s =>
    (selectedFuels.length === 0 || selectedFuels.some(f => s.fuels[f] !== false)) &&
    selectedServices.every(v => s.services[v] === true)
  );

  document.getElementById("stationCount").textContent = allStations.length ? allStations.length : "-";
  document.getElementById("totalKm").textContent = routeTotal || "-";
  document.getElementById("countShown").textContent = allStations.length ? shown.length : "-";

  const nextHint = document.getElementById("nextHint");
  if (!allStations.length) {
    nextHint.textContent = "";
  } else if (shown.length) {
    nextHint.textContent = `أقرب محطة مطابقة تبعد ${Math.max(0, shown[0].km - startKm)} كم عنك · عدد المحطات أمامك ${ahead.length}`;
  } else {
    nextHint.textContent = `عدد المحطات أمامك ${ahead.length}، ولا توجد محطة مطابقة لاختياراتك`;
  }

  // ====== الخريطة ======
  const shownKeys = new Set(shown.map(s => `${s.lat},${s.lng}`));
  markersLayer.clearLayers();

  allStations.forEach(s => {
    const match = shownKeys.has(`${s.lat},${s.lng}`);
    L.circleMarker([s.lat, s.lng], {
      radius: match ? 10 : 7,
      color: match ? "#C4A46A" : "#145A38",
      fillColor: match ? "#145A38" : "#ffffff",
      fillOpacity: 0.95,
      weight: 2
    })
      .bindPopup(`<b>${escapeHtml(s.name)}</b><br>على بعد ${s.km} كم من الرياض<br>${match ? "✅ تطابق اختياراتك" : "⚪ خارج الفلاتر أو تجاوزته"}`)
      .addTo(markersLayer);
  });

  const road = routeCache[currentRoute];
  if (road && road.cum.length) {
    let idx = road.cum.findIndex(c => c >= startKm);
    if (idx < 0) idx = road.coords.length - 1;
    const p = road.coords[idx];
    L.circleMarker([p.lat, p.lng], {
      radius: 9, color: "#0C3A25", fillColor: "#C4A46A", fillOpacity: 1, weight: 3
    }).bindPopup("موقعك الحالي (≈ " + startKm + " كم من الرياض)").addTo(markersLayer);
  }

  // ====== البطاقات ======
  if (!allStations.length) {
    list.innerHTML = `<div class="empty">لا توجد محطات معروضة الآن. اضغط «ابحث عن المحطات» بعد التأكد من الاتصال.</div>`;
    return;
  }
  if (shown.length === 0) {
    list.innerHTML = `<div class="empty">ما فيه محطات تطابق اختياراتك أمامك على هذا الطريق. جرّب تخفف الفلاتر أو تغيّر الكيلومتر.</div>`;
    return;
  }

  list.innerHTML = shown.map((s, i) => {
    const fuelItems = [["p91", "بنزين 91"], ["p95", "بنزين 95"], ["diesel", "ديزل"]]
      .map(([k, label]) => {
        const v = s.fuels[k];
        const text = v === true
          ? `${SAR_PRICES[k].toFixed(2)} ريال (مرجعي)`
          : v === false ? "لا يبيع" : "غير مسجل في OSM";
        return `<li><span>${label}</span><strong class="${v === true ? "" : "muted"}">${text}</strong></li>`;
      }).join("");

    const serviceTags = Object.entries(SERVICE_META).map(([k, [icon, label]]) => {
      const ok = s.services[k] === true;
      return `<span class="tag ${ok ? "" : "unknown"}" title="${ok ? "مرصودة في OSM" : "غير مؤكدة: لم تُرصد في OSM"}">
        <svg class="ic"><use href="#${icon}"/></svg>${label}${ok ? " ✓" : " · غير مؤكد"}
      </span>`;
    }).join("");

    const nearbyHtml = s.nearby.length
      ? s.nearby.slice(0, 8).map(n =>
          `<li>${escapeHtml(n.label)}${n.name ? ": " + escapeHtml(n.name) : ""}</li>`
        ).join("")
      : "<li>لا توجد مساجد أو مطاعم أو مقاهٍ مسجلة ضمن 500 متر</li>";

    const gapWarning = s.gap > GAP_WARNING_KM
      ? `<div class="warn">⚠️ فاصل ${s.gap} كم من المحطة اللي قبلها، خذ احتياطك</div>`
      : "";

    const dist = Math.max(0, s.km - startKm);
    // رابط الملاحة بإحداثيات المحطة الفعلية
    const navUrl = `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`;

    return `
      <article class="s-card ${i === 0 ? "nearest" : ""}">
        ${i === 0 ? '<span class="badge">الأقرب</span>' : ""}
        <div class="s-main">
          <div class="s-icon"><svg class="ic"><use href="#i-fuel"/></svg></div>
          <div class="s-info">
            <div class="s-name">${escapeHtml(s.name)}</div>
            <div class="s-brand">${escapeHtml(s.brand)}</div>
          </div>
          <span class="s-dist">${dist} كم</span>
        </div>
        <div class="s-meta">
          <span>📍 على الطريق عند ${s.km} كم من الرياض</span>
          <span>🕒 ${escapeHtml(s.hours)}</span>
        </div>
        ${gapWarning}
        <div class="tags">${serviceTags}</div>
        <details class="more">
          <summary>الأسعار المرجعية والمطاعم القريبة</summary>
          <div class="sec-title">⛽ الأسعار المرجعية (${PRICES_PERIOD})</div>
          <ul class="fuels">${fuelItems}</ul>
          <div class="sec-title">🍽️ قريب منك</div>
          <ul class="rest-list">${nearbyHtml}</ul>
        </details>
        <a class="nav-btn" target="_blank" rel="noopener" href="${navUrl}">
          <svg class="ic sm"><use href="#i-ext"/></svg> ابدأ الملاحة
        </a>
      </article>`;
  }).join("");
}

refresh();

