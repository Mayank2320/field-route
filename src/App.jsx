import { useState, useEffect, useCallback, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

// ============================================================
// INDEXEDDB
// ============================================================
const DB_NAME = "FieldRoutePlannerDB";
const DB_VERSION = 1;
const STORE_NAME = "days";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME))
        db.createObjectStore(STORE_NAME, { keyPath: "day" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveDay(data) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(data);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function loadAllDays() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

// ============================================================
// GEOCODING
// ============================================================
async function geocodeAddress(address) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address + ", Surat, Gujarat, India")}&format=json&limit=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  const data = await res.json();
  if (!data.length) throw new Error("Address not found");
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
}

// ============================================================
// OSRM
// ============================================================
async function getDistanceMatrix(locations) {
  const coords = locations.map(l => `${l.lng},${l.lat}`).join(";");
  const res = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`);
  const data = await res.json();
  if (data.code !== "Ok") throw new Error("OSRM error");
  return data.durations;
}

async function getRouteGeometry(locations) {
  const coords = locations.map(l => `${l.lng},${l.lat}`).join(";");
  const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`);
  const data = await res.json();
  if (data.code !== "Ok") return null;
  return {
    coordinates: data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distance: data.routes[0].distance,
    duration: data.routes[0].duration,
  };
}

// ============================================================
// TSP SOLVER
// ============================================================
function solveTSP(matrix) {
  const n = matrix.length;
  if (n <= 1) return { order: [0], totalTime: 0 };
  let bestOrder = null, bestTime = Infinity;
  for (let start = 0; start < n; start++) {
    const visited = new Array(n).fill(false);
    const order = [start];
    visited[start] = true;
    let current = start, totalTime = 0;
    for (let i = 1; i < n; i++) {
      let nearest = -1, nearestDist = Infinity;
      for (let j = 0; j < n; j++) {
        if (!visited[j] && matrix[current][j] < nearestDist) {
          nearestDist = matrix[current][j]; nearest = j;
        }
      }
      if (nearest === -1) break;
      visited[nearest] = true; order.push(nearest);
      totalTime += nearestDist; current = nearest;
    }
    if (totalTime < bestTime) { bestTime = totalTime; bestOrder = [...order]; }
  }
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        const [a, b, c, d] = [bestOrder[i-1], bestOrder[i], bestOrder[j], bestOrder[j+1]];
        if (matrix[a][c] + matrix[b][d] < matrix[a][b] + matrix[c][d]) {
          bestOrder.splice(i, j - i + 1, ...bestOrder.slice(i, j + 1).reverse());
          improved = true;
        }
      }
    }
  }
  let total = 0;
  for (let i = 0; i < bestOrder.length - 1; i++) total += matrix[bestOrder[i]][bestOrder[i+1]];
  return { order: bestOrder, totalTime: total };
}

// ============================================================
// HELPERS
// ============================================================
const fmtTime = (s) => { if (!s) return "0m"; const h = Math.floor(s/3600), m = Math.floor((s%3600)/60); return h > 0 ? `${h}h ${m}m` : `${m}m`; };
const fmtDist = (m) => { if (!m) return "0 km"; return (m/1000).toFixed(1) + " km"; };
const DAYS = Array.from({ length: 12 }, (_, i) => i + 1);
const EMPTY_DAY = (day) => ({ day, locations: [], optimizedOrder: null, routeGeometry: null, totalTime: 0, totalDist: 0, updatedAt: null });

// ============================================================
// MAP COMPONENT
// ============================================================
function MapView({ locations, route, onToggleVisited, isFullscreen }) {
  const mapRef = useRef(null);
  const leafletMap = useRef(null);
  const markersRef = useRef([]);
  const polylineRef = useRef(null);

  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;
    leafletMap.current = L.map(mapRef.current, {
      zoomControl: false,
      attributionControl: false,
    }).setView([21.17, 72.83], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(leafletMap.current);
    L.control.zoom({ position: "bottomright" }).addTo(leafletMap.current);
  }, []);

  useEffect(() => {
    if (!leafletMap.current) return;
    setTimeout(() => leafletMap.current.invalidateSize(), 300);
  }, [isFullscreen]);

  useEffect(() => {
    if (!leafletMap.current) return;
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    if (polylineRef.current) { polylineRef.current.remove(); polylineRef.current = null; }
    if (!locations.length) return;

    const bounds = [];
    locations.forEach((loc, idx) => {
      const color = loc.visited ? "#22c55e" : "#f97316";
      const border = loc.visited ? "#16a34a" : "#ea580c";
      const num = loc.optimizedIndex !== undefined ? loc.optimizedIndex + 1 : idx + 1;
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:34px;height:34px;background:${color};border:3px solid ${border};border-radius:50% 50% 50% 0;transform:rotate(-45deg);display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(0,0,0,0.5);">
          <span style="transform:rotate(45deg);color:#fff;font-weight:800;font-size:12px;font-family:monospace;">${num}</span>
        </div>`,
        iconSize: [34, 34], iconAnchor: [17, 34], popupAnchor: [0, -38],
      });
      const marker = L.marker([loc.lat, loc.lng], { icon }).addTo(leafletMap.current);
      marker.bindPopup(`
        <div style="font-family:sans-serif;min-width:180px;padding:4px;">
          <div style="font-weight:700;font-size:14px;margin-bottom:2px;">#${num} ${loc.name || "Location"}</div>
          <div style="font-size:11px;color:#666;margin-bottom:10px;">${loc.address}</div>
          <div style="display:flex;gap:6px;">
            <button onclick="window.frpToggle('${loc.id}')" style="flex:1;padding:6px;background:${loc.visited ? "#ef4444" : "#22c55e"};color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">
              ${loc.visited ? "↩ Pending" : "✓ Done"}
            </button>
            <a href="https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}" target="_blank"
              style="flex:1;padding:6px;background:#3b82f6;color:#fff;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;text-align:center;">
              ↗ Go
            </a>
          </div>
        </div>
      `);
      bounds.push([loc.lat, loc.lng]);
      markersRef.current.push(marker);
    });

    if (route) {
      polylineRef.current = L.polyline(route, { color: "#f97316", weight: 4, opacity: 0.85, dashArray: "10,5" }).addTo(leafletMap.current);
    }
    if (bounds.length) leafletMap.current.fitBounds(bounds, { padding: [50, 50] });
    window.frpToggle = (id) => onToggleVisited(id);
  }, [locations, route]);

  return <div ref={mapRef} style={{ width: "100%", height: "100%", background: "#1a2030" }} />;
}

// ============================================================
// MAIN APP
// ============================================================
export default function App() {
  const [activeDay, setActiveDay] = useState(1);
  const [activeWeek, setActiveWeek] = useState(1);
  const [dayData, setDayData] = useState(() => Object.fromEntries(DAYS.map(d => [d, EMPTY_DAY(d)])));
  const [addressInput, setAddressInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [bulkInput, setBulkInput] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [status, setStatus] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [dbReady, setDbReady] = useState(false);
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [activeTab, setActiveTab] = useState("list");
  const [homeAddress, setHomeAddress] = useState(() => localStorage.getItem("frp_home") || "");
const [officeAddress, setOfficeAddress] = useState(() => localStorage.getItem("frp_office") || "");
const [homeCoords, setHomeCoords] = useState(() => {
  const s = localStorage.getItem("frp_home_coords");
  return s ? JSON.parse(s) : null;
});
const [officeCoords, setOfficeCoords] = useState(() => {
  const s = localStorage.getItem("frp_office_coords");
  return s ? JSON.parse(s) : null;
});
  useEffect(() => {
    loadAllDays().then(rows => {
      if (rows.length) {
        setDayData(prev => {
          const next = { ...prev };
          rows.forEach(r => { next[r.day] = r; });
          return next;
        });
      }
      setDbReady(true);
    }).catch(() => setDbReady(true));
  }, []);

  const currentDay = dayData[activeDay];
  const sortedLocs = [...currentDay.locations].sort((a, b) => {
    if (a.optimizedIndex == null && b.optimizedIndex == null) return 0;
    if (a.optimizedIndex == null) return 1;
    if (b.optimizedIndex == null) return -1;
    return a.optimizedIndex - b.optimizedIndex;
  });
  const visited = currentDay.locations.filter(l => l.visited).length;
  const pending = currentDay.locations.length - visited;
  const progress = currentDay.locations.length ? (visited / currentDay.locations.length) * 100 : 0;

  const updateCurrentDay = useCallback((updater) => {
    setDayData(prev => {
      const updated = { ...prev, [activeDay]: updater(prev[activeDay]) };
      saveDay({ ...updated[activeDay], updatedAt: new Date().toISOString() }).catch(console.error);
      return updated;
    });
  }, [activeDay]);
  const saveHomeOffice = async (type, address) => {
  setStatus(`Saving ${type}...`);
  try {
    const gm =
      address.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
      address.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
      address.match(/place\/(-?\d+\.\d+),(-?\d+\.\d+)/);
    let geo;
    if (gm) {
      const lat = parseFloat(gm[1]), lng = parseFloat(gm[2]);
      if (isNaN(lat) || isNaN(lng)) throw new Error("Invalid coordinates");
      geo = { lat, lng };
    } else {
      geo = await geocodeAddress(address);
    }
    const coords = { lat: geo.lat, lng: geo.lng };
    if (type === "home") {
      setHomeCoords(coords);
      localStorage.setItem("frp_home", address);
      localStorage.setItem("frp_home_coords", JSON.stringify(coords));
      setStatus("✓ Home saved");
    } else {
      setOfficeCoords(coords);
      localStorage.setItem("frp_office", address);
      localStorage.setItem("frp_office_coords", JSON.stringify(coords));
      setStatus("✓ Office saved");
    }
  } catch (e) { setStatus(`✗ ${e.message}`); }
};
  const navigateNextStop = () => {
    const next = sortedLocs.find(l => !l.visited);
    if (!next) { setStatus("✓ All locations completed!"); return; }
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${next.lat},${next.lng}&travelmode=driving`, "_blank");
  };

  const addLocation = async () => {
    const addr = addressInput.trim();
    if (!addr) return;
    const googleMatch =
  addr.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
  addr.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
  addr.match(/place\/(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (googleMatch) {
      const loc = { id: crypto.randomUUID(), address: addr, name: nameInput.trim() || "Shop", lat: parseFloat(googleMatch[1]), lng: parseFloat(googleMatch[2]), visited: false, optimizedIndex: undefined };
      updateCurrentDay(d => ({ ...d, locations: [...d.locations, loc], optimizedOrder: null, routeGeometry: null }));
      setAddressInput(""); setNameInput(""); setStatus("✓ Added from Google Maps link"); setActiveTab("list");
      return;
    }
    setGeocoding(true); setStatus("Geocoding...");
    try {
      const geo = await geocodeAddress(addr);
      const loc = { id: crypto.randomUUID(), address: addr, name: nameInput.trim() || addr.split(",")[0], lat: geo.lat, lng: geo.lng, display: geo.display, visited: false, optimizedIndex: undefined };
      updateCurrentDay(d => ({ ...d, locations: [...d.locations, loc], optimizedOrder: null, routeGeometry: null }));
      setAddressInput(""); setNameInput(""); setStatus(`✓ Added: ${loc.name}`); setActiveTab("list");
    } catch (e) { setStatus(`✗ ${e.message}`); }
    finally { setGeocoding(false); }
  };

  const addBulk = async () => {
    const lines = bulkInput.trim().split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setGeocoding(true);
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      setStatus(`Geocoding ${i + 1}/${lines.length}...`);
      try {
  const gmatch =
    lines[i].match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
    lines[i].match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) ||
    lines[i].match(/place\/(-?\d+\.\d+),(-?\d+\.\d+)/);
  const geo = gmatch
    ? { lat: parseFloat(gmatch[1]), lng: parseFloat(gmatch[2]) }
    : await geocodeAddress(lines[i]);
  const name = gmatch ? "Shop" : lines[i].split(",")[0];
  results.push({ id: crypto.randomUUID(), address: lines[i], name, lat: geo.lat, lng: geo.lng, visited: false, optimizedIndex: undefined });
  if (!gmatch) await new Promise(r => setTimeout(r, 1000));
} catch { await new Promise(r => setTimeout(r, 500)); }
    }
    updateCurrentDay(d => ({ ...d, locations: [...d.locations, ...results], optimizedOrder: null, routeGeometry: null }));
    setBulkInput(""); setShowBulk(false); setGeocoding(false);
    setStatus(`✓ Added ${results.length}/${lines.length} locations`); setActiveTab("list");
  };

  const optimizeRoute = async () => {
    const middleLocs = currentDay.locations;
if (middleLocs.length < 1) { setStatus("Need at least 1 location"); return; }
const startLoc = homeCoords ? { id: "__home__", name: "🏠 Home", address: homeAddress, lat: homeCoords.lat, lng: homeCoords.lng, visited: false, optimizedIndex: undefined } : null;
const endLoc = officeCoords ? { id: "__office__", name: "🏢 Office", address: officeAddress, lat: officeCoords.lat, lng: officeCoords.lng, visited: false, optimizedIndex: undefined } : null;
const locs = [...(startLoc ? [startLoc] : []), ...middleLocs, ...(endLoc ? [endLoc] : [])];
    setOptimizing(true); setStatus("Building distance matrix...");
    try {
      const matrix = await getDistanceMatrix(locs);
      setStatus("Solving optimal route...");
      let order, totalTime;
if (startLoc && endLoc && middleLocs.length >= 1) {
  const n = middleLocs.length;
  const subMatrix = matrix.slice(1, 1 + n).map(row => row.slice(1, 1 + n));
  let bestMiddle = Array.from({ length: n }, (_, i) => i);
  let bestTime = Infinity;
  for (let s = 0; s < n; s++) {
    const vis = new Array(n).fill(false);
    const ord = [s]; vis[s] = true; let cur = s, t = 0;
    for (let i = 1; i < n; i++) {
      let near = -1, nearD = Infinity;
      for (let j = 0; j < n; j++) {
        if (!vis[j] && subMatrix[cur][j] < nearD) { nearD = subMatrix[cur][j]; near = j; }
      }
      if (near === -1) break;
      vis[near] = true; ord.push(near); t += nearD; cur = near;
    }
    const cost = matrix[0][ord[0] + 1] + t + matrix[ord[ord.length - 1] + 1][locs.length - 1];
    if (cost < bestTime) { bestTime = cost; bestMiddle = [...ord]; }
  }
  order = [0, ...bestMiddle.map(i => i + 1), locs.length - 1];
  totalTime = bestTime;
} else {
  ({ order, totalTime } = solveTSP(matrix));
}
      const orderedLocs = order.map((idx, pos) => ({ ...locs[idx], optimizedIndex: pos }));
      const indexMap = Object.fromEntries(orderedLocs.map(l => [l.id, l.optimizedIndex]));
      setStatus("Fetching route path...");
      const routeData = await getRouteGeometry(orderedLocs);
      updateCurrentDay(d => ({
        ...d,
        locations: d.locations.map(l => indexMap[l.id] !== undefined ? { ...l, optimizedIndex: indexMap[l.id] } : l),
        optimizedOrder: order, routeGeometry: routeData?.coordinates || null,
        totalTime, totalDist: routeData?.distance || 0,
      }));
      setStatus(`✓ ${fmtDist(routeData?.distance)} · ${fmtTime(routeData?.duration)} · ${locs.length} stops`);
    } catch (e) { setStatus(`✗ ${e.message}`); }
    finally { setOptimizing(false); }
  };

  const toggleVisited = (id) => {
    updateCurrentDay(d => ({ ...d, locations: d.locations.map(l => l.id === id ? { ...l, visited: !l.visited } : l) }));
  };

  const removeLocation = (id) => {
    updateCurrentDay(d => ({ ...d, locations: d.locations.filter(l => l.id !== id), optimizedOrder: null, routeGeometry: null, totalTime: 0, totalDist: 0 }));
  };

  const clearDay = () => {
    if (!confirm("Clear all locations for this day?")) return;
    updateCurrentDay(() => EMPTY_DAY(activeDay));
    setStatus("Day cleared");
  };

  const visibleDays = DAYS.filter(d => activeWeek === 1 ? d <= 6 : d > 6);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { height: 100%; overflow: hidden; overscroll-behavior: none; -webkit-overflow-scrolling: touch; }
        #root { position: fixed; inset: 0; display: flex; flex-direction: column; background: #0c0f14; }
        body { font-family: 'Syne', sans-serif; color: #e8e3db; }

        .header { background: #0c0f14; border-bottom: 1px solid #1e2633; flex-shrink: 0; padding: 10px 14px 0; }
        .header-top { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .logo { font-size: 17px; font-weight: 800; color: #f97316; letter-spacing: -0.5px; margin-right: auto; }
        .logo span { color: #e8e3db; }
        .week-btn { padding: 4px 10px; border: 1px solid #2a3040; background: transparent; color: #6b7280; border-radius: 5px; font-size: 11px; font-family: 'DM Mono', monospace; cursor: pointer; transition: all 0.15s; }
        .week-btn.active { background: #f97316; color: #0c0f14; border-color: #f97316; font-weight: 700; }
        .ready-dot { font-size: 10px; font-family: 'DM Mono', monospace; color: #374151; white-space: nowrap; }
        .ready-dot.on { color: #22c55e; }
        .day-tabs { display: flex; overflow-x: auto; scrollbar-width: none; }
        .day-tabs::-webkit-scrollbar { display: none; }
        .day-tab { padding: 7px 14px; background: transparent; border: none; color: #4b5563; font-family: 'DM Mono', monospace; font-size: 11px; cursor: pointer; border-bottom: 2px solid transparent; white-space: nowrap; transition: all 0.15s; flex-shrink: 0; }
        .day-tab.active { color: #f97316; border-bottom-color: #f97316; }
        .day-tab .ct { display: inline-block; margin-left: 3px; background: #1e2633; color: #6b7280; border-radius: 8px; padding: 0 5px; font-size: 9px; }
        .day-tab.active .ct { background: #2c1810; color: #f97316; }

        .status-bar { background: #080b10; border-bottom: 1px solid #141b24; padding: 5px 14px; font-family: 'DM Mono', monospace; font-size: 10px; color: #4b5563; flex-shrink: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 26px; display: flex; align-items: center; gap: 6px; }
        .spinner { width: 10px; height: 10px; flex-shrink: 0; border: 2px solid #f97316; border-top-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        .map-wrapper { height: 36vh; min-height: 160px; flex-shrink: 0; position: relative; background: #1a2030; }
        .map-wrapper.fullscreen { position: fixed; inset: 0; height: 100% !important; z-index: 9999; }
        .map-fullscreen-btn { position: absolute; top: 10px; right: 10px; z-index: 1000; background: rgba(12,15,20,0.9); border: 1px solid #f97316; color: #f97316; border-radius: 6px; padding: 6px 12px; font-family: 'DM Mono', monospace; font-size: 11px; cursor: pointer; font-weight: 600; }

        .bottom-panel { flex: 1; display: flex; flex-direction: column; min-height: 0; background: #0f1520; overflow: hidden; }

        .stats-bar { display: flex; gap: 1px; flex-shrink: 0; border-bottom: 1px solid #1e2633; }
        .stat-cell { flex: 1; padding: 8px 4px; text-align: center; background: #0c1018; }
        .stat-cell + .stat-cell { border-left: 1px solid #1e2633; }
        .stat-v { font-family: 'DM Mono', monospace; font-size: 18px; font-weight: 700; color: #f97316; line-height: 1; }
        .stat-l { font-size: 9px; color: #374151; margin-top: 2px; text-transform: uppercase; letter-spacing: 1px; }

        .progress-wrap { height: 3px; background: #1e2633; flex-shrink: 0; }
        .progress-fill { height: 100%; background: linear-gradient(90deg, #22c55e, #16a34a); transition: width 0.5s ease; }

        .action-bar { display: flex; gap: 8px; padding: 10px 12px; flex-shrink: 0; border-bottom: 1px solid #1e2633; }
        .btn-optimize { flex: 1; padding: 11px; background: linear-gradient(135deg, #f97316, #ea580c); color: #0c0f14; border: none; border-radius: 8px; font-family: 'Syne', sans-serif; font-weight: 800; font-size: 13px; cursor: pointer; transition: all 0.2s; }
        .btn-optimize:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-nav { padding: 11px 14px; background: #15803d; color: #e8e3db; border: none; border-radius: 8px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 12px; cursor: pointer; white-space: nowrap; }
        .btn-clear { padding: 11px 12px; background: #1e2633; color: #ef4444; border: none; border-radius: 8px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 12px; cursor: pointer; }

        .panel-tabs { display: flex; border-bottom: 1px solid #1e2633; flex-shrink: 0; }
        .panel-tab { flex: 1; padding: 10px; border: none; background: transparent; color: #4b5563; font-family: 'Syne', sans-serif; font-size: 12px; font-weight: 700; cursor: pointer; border-bottom: 2px solid transparent; transition: all 0.15s; }
        .panel-tab.active { color: #f97316; border-bottom-color: #f97316; background: #0c1018; }

        .scroll-area { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; min-height: 0; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-thumb { background: #2a3040; border-radius: 2px; }

        .loc-list { padding: 8px; }
        .loc-item { background: #141d2b; border: 1px solid #1e2a3a; border-radius: 10px; padding: 10px 12px; margin-bottom: 6px; display: flex; gap: 10px; align-items: center; transition: all 0.15s; }
        .loc-item.visited { background: #0d1a12; border-color: #14532d; }
        .loc-num { width: 28px; height: 28px; min-width: 28px; border-radius: 50%; background: #f97316; color: #0c0f14; font-family: 'DM Mono', monospace; font-weight: 800; font-size: 11px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .loc-item.visited .loc-num { background: #22c55e; }
        .loc-info { flex: 1; min-width: 0; }
        .loc-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .loc-item.visited .loc-name { color: #4b5563; text-decoration: line-through; }
        .loc-addr { font-size: 10px; color: #374151; font-family: 'DM Mono', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
        .loc-actions { display: flex; gap: 4px; flex-shrink: 0; }
        .icon-btn { width: 30px; height: 30px; background: #1e2633; border: none; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #6b7280; font-size: 14px; transition: all 0.15s; }
        .icon-btn.done { background: #14532d; color: #22c55e; }
        .icon-btn.nav-btn { background: #1e3a5f; color: #60a5fa; text-decoration: none; }
        .icon-btn.del { background: #2d1616; color: #f87171; }

        .empty { padding: 40px 20px; text-align: center; color: #2a3a50; }
        .empty-icon { font-size: 36px; margin-bottom: 10px; }
        .empty-text { font-size: 13px; line-height: 1.7; }

        .add-form { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
        .field { background: #141d2b; border: 1px solid #1e2a3a; color: #e8e3db; padding: 10px 12px; border-radius: 8px; font-size: 13px; font-family: 'DM Mono', monospace; outline: none; transition: border-color 0.15s; width: 100%; }
        .field:focus { border-color: #f97316; }
        .field::placeholder { color: #2a3a50; }
        textarea.field { resize: none; height: 100px; }
        .btn-add { padding: 11px; background: #f97316; color: #0c0f14; border: none; border-radius: 8px; font-family: 'Syne', sans-serif; font-weight: 800; font-size: 13px; cursor: pointer; flex: 1; }
        .btn-add:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-bulk-toggle { padding: 11px 14px; background: #1e2633; color: #9ca3af; border: none; border-radius: 8px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 12px; cursor: pointer; white-space: nowrap; }
        .row { display: flex; gap: 8px; }

        .leaflet-container { width: 100% !important; height: 100% !important; }
        .leaflet-control-zoom { margin-bottom: 16px !important; margin-right: 16px !important; }
      `}</style>

      <div className="header">
        <div className="header-top">
          <div className="logo">FIELD<span>ROUTE</span></div>
          <button className={`week-btn ${activeWeek === 1 ? "active" : ""}`} onClick={() => { setActiveWeek(1); setActiveDay(1); }}>W1</button>
          <button className={`week-btn ${activeWeek === 2 ? "active" : ""}`} onClick={() => { setActiveWeek(2); setActiveDay(7); }}>W2</button>
          <div className={`ready-dot ${dbReady ? "on" : ""}`}>{dbReady ? "● RDY" : "● ..."}</div>
        </div>
        <div className="day-tabs">
          {visibleDays.map(d => (
            <button key={d} className={`day-tab ${activeDay === d ? "active" : ""}`} onClick={() => setActiveDay(d)}>
              Day {activeWeek === 1 ? d : d - 6}
              <span className="ct">{dayData[d].locations.length}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="status-bar">
        {(optimizing || geocoding) && <div className="spinner" />}
        <span>{status || "Ready · Select a day and add stops"}</span>
      </div>

      <div className={`map-wrapper ${mapFullscreen ? "fullscreen" : ""}`}>
        <MapView locations={sortedLocs} route={currentDay.routeGeometry} onToggleVisited={toggleVisited} isFullscreen={mapFullscreen} />
        <button className="map-fullscreen-btn" onClick={() => setMapFullscreen(v => !v)}>
          {mapFullscreen ? "✕ Exit" : "⤢ Full"}
        </button>
      </div>

      {!mapFullscreen && (
        <div className="bottom-panel">
          <div className="stats-bar">
            <div className="stat-cell">
              <div className="stat-v">{currentDay.locations.length}</div>
              <div className="stat-l">Stops</div>
            </div>
            <div className="stat-cell">
              <div className="stat-v" style={{ color: "#22c55e" }}>{visited}</div>
              <div className="stat-l">Done</div>
            </div>
            <div className="stat-cell">
              <div className="stat-v" style={{ color: "#f97316" }}>{pending}</div>
              <div className="stat-l">Left</div>
            </div>
            {currentDay.totalDist > 0 && (
              <div className="stat-cell">
                <div className="stat-v" style={{ color: "#a78bfa", fontSize: 13 }}>{fmtDist(currentDay.totalDist)}</div>
                <div className="stat-l">{fmtTime(currentDay.totalTime)}</div>
              </div>
            )}
          </div>

          <div className="progress-wrap">
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>

          <div className="action-bar">
            <button className="btn-optimize" onClick={optimizeRoute} disabled={optimizing || currentDay.locations.length < 2}>
              {optimizing ? "Optimizing..." : "⚡ Optimize Route"}
            </button>
            {currentDay.optimizedOrder && (
              <button className="btn-nav" onClick={navigateNextStop}>▶ Next</button>
            )}
            <button className="btn-clear" onClick={clearDay}>✕</button>
          </div>

          <div className="panel-tabs">
            <button className={`panel-tab ${activeTab === "list" ? "active" : ""}`} onClick={() => setActiveTab("list")}>
              📍 Stops {currentDay.locations.length > 0 ? `(${currentDay.locations.length})` : ""}
            </button>
            <button className={`panel-tab ${activeTab === "add" ? "active" : ""}`} onClick={() => setActiveTab("add")}>
              + Add Stop
            </button>
            <button className={`panel-tab ${activeTab === "settings" ? "active" : ""}`} onClick={() => setActiveTab("settings")}>
  ⚙ Routes
</button>
          </div>

          <div className="scroll-area">
            {activeTab === "list" && (
              <div className="loc-list">
                {sortedLocs.length === 0 ? (
                  <div className="empty">
                    <div className="empty-icon">🗺️</div>
                    <div className="empty-text">No stops yet.<br />Tap <strong>+ Add Stop</strong> to begin.</div>
                  </div>
                ) : sortedLocs.map((loc, idx) => (
                  <div key={loc.id} className={`loc-item ${loc.visited ? "visited" : ""}`}>
                    <div className="loc-num">{idx + 1}</div>
                    <div className="loc-info">
                      <div className="loc-name">{loc.name}</div>
                      <div className="loc-addr">{loc.address}</div>
                    </div>
                    <div className="loc-actions">
                      <button className={`icon-btn ${loc.visited ? "done" : ""}`} onClick={() => toggleVisited(loc.id)}>
                        {loc.visited ? "✓" : "○"}
                      </button>
                      <a href={`https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`} target="_blank" rel="noopener noreferrer" className="icon-btn nav-btn">↗</a>
                      <button className="icon-btn del" onClick={() => removeLocation(loc.id)}>×</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {activeTab === "settings" && (
  <div className="add-form">
    <div style={{ fontSize: 11, color: "#4b5563", fontFamily: "'DM Mono',monospace", marginBottom: 4 }}>🏠 HOME — Start Point</div>
    <input className="field" placeholder="Home address or paste Google Maps link" value={homeAddress} onChange={e => setHomeAddress(e.target.value)} />
    <button className="btn-add" onClick={() => saveHomeOffice("home", homeAddress)} disabled={!homeAddress.trim()}>Save Home</button>
    {homeCoords && <div style={{ fontSize: 10, color: "#22c55e", fontFamily: "'DM Mono',monospace" }}>✓ Saved: {homeAddress.substring(0, 40)}</div>}
    <div style={{ fontSize: 11, color: "#4b5563", fontFamily: "'DM Mono',monospace", marginBottom: 4, marginTop: 12 }}>🏢 OFFICE — End Point</div>
    <input className="field" placeholder="Office address or paste Google Maps link" value={officeAddress} onChange={e => setOfficeAddress(e.target.value)} />
    <button className="btn-add" onClick={() => saveHomeOffice("office", officeAddress)} disabled={!officeAddress.trim()}>Save Office</button>
    {officeCoords && <div style={{ fontSize: 10, color: "#22c55e", fontFamily: "'DM Mono',monospace" }}>✓ Saved: {officeAddress.substring(0, 40)}</div>}
  </div>
)}
            {activeTab === "add" && (
              <div className="add-form">
                <input className="field" placeholder="Shop / party name (optional)" value={nameInput} onChange={e => setNameInput(e.target.value)} />
                <input className="field" placeholder="Address, area or paste Google Maps link" value={addressInput} onChange={e => setAddressInput(e.target.value)} onKeyDown={e => e.key === "Enter" && addLocation()} />
                <div className="row">
                  <button className="btn-add" onClick={addLocation} disabled={geocoding || !addressInput.trim()}>
                    {geocoding ? "Adding..." : "Add Stop"}
                  </button>
                  <button className="btn-bulk-toggle" onClick={() => setShowBulk(v => !v)}>
                    {showBulk ? "↑ Hide" : "⊞ Bulk"}
                  </button>
                </div>
                {showBulk && (
                  <>
                    <textarea className="field" placeholder={"One address per line:\nRing Road, Surat\nAdajan Patiya\nVesu, Surat"} value={bulkInput} onChange={e => setBulkInput(e.target.value)} />
                    <button className="btn-add" onClick={addBulk} disabled={geocoding || !bulkInput.trim()}>
                      {geocoding ? "Processing..." : `Add ${bulkInput.trim().split("\n").filter(Boolean).length} Stops`}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}