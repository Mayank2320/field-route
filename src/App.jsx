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
// INDEXEDDB STORAGE
// ============================================================
const DB_NAME = "FieldRoutePlannerDB";
const DB_VERSION = 1;
const STORE_NAME = "days";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "day" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDay(dayData) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(dayData);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadAllDays() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ============================================================
// GEOCODING (Nominatim)
// ============================================================
async function geocodeAddress(address) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address + ", Surat, Gujarat, India")}&format=json&limit=1`;
  const res = await fetch(url, { headers: { "Accept-Language": "en" } });
  const data = await res.json();
  if (!data.length) throw new Error("Address not found");
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), display: data[0].display_name };
}

// ============================================================
// OSRM DISTANCE MATRIX
// ============================================================
async function getDistanceMatrix(locations) {
  const coords = locations.map(l => `${l.lng},${l.lat}`).join(";");
  const url = `https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== "Ok") throw new Error("OSRM error");
  return data.durations; // seconds matrix
}

// ============================================================
// TSP SOLVER (Nearest Neighbor + 2-opt)
// ============================================================
function solveTSP(matrix) {
  const n = matrix.length;
  if (n <= 1) return { order: [0], totalTime: 0 };

  let bestOrder = null;
  let bestTime = Infinity;

  // Try each starting node
  for (let start = 0; start < n; start++) {
    const visited = new Array(n).fill(false);
    const order = [start];
    visited[start] = true;
    let current = start;
    let totalTime = 0;

    for (let i = 1; i < n; i++) {
      let nearest = -1;
      let nearestDist = Infinity;
      for (let j = 0; j < n; j++) {
        if (!visited[j] && matrix[current][j] < nearestDist) {
          nearestDist = matrix[current][j];
          nearest = j;
        }
      }
      if (nearest === -1) break;
visited[nearest] = true;
order.push(nearest);
totalTime += nearestDist;
current = nearest;
    }

    if (totalTime < bestTime) {
      bestTime = totalTime;
      bestOrder = [...order];
    }
  }

  // 2-opt improvement (fixed)
let improved = true;
while (improved) {
  improved = false;
  for (let i = 1; i < n - 2; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      const a = bestOrder[i - 1];
      const b = bestOrder[i];
      const c = bestOrder[j];
      const d = bestOrder[j + 1];

      const before = matrix[a][b] + matrix[c][d];
      const after = matrix[a][c] + matrix[b][d];

      if (after < before) {
        bestOrder.splice(i, j - i + 1, ...bestOrder.slice(i, j + 1).reverse());
        improved = true;
      }
    }
  }
}

  // Recalculate total
  let total = 0;
  for (let i = 0; i < bestOrder.length - 1; i++) {
    total += matrix[bestOrder[i]][bestOrder[i + 1]];
  }

  return { order: bestOrder, totalTime: total };
}

// ============================================================
// OSRM ROUTE GEOMETRY
// ============================================================
async function getRouteGeometry(locations) {
  const coords = locations.map(l => `${l.lng},${l.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== "Ok") return null;
  return {
    coordinates: data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distance: data.routes[0].distance,
    duration: data.routes[0].duration,
  };
}

// ============================================================
// FORMAT HELPERS
// ============================================================
function fmtTime(seconds) {
  if (!seconds) return "0m";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtDist(meters) {
  if (!meters) return "0 km";
  return (meters / 1000).toFixed(1) + " km";
}

// ============================================================
// MAP COMPONENT (Leaflet)
// ============================================================
function MapView({ locations, route, onToggleVisited }) {
  const mapRef = useRef(null);
  const leafletMap = useRef(null);
  const markersRef = useRef([]);
  const polylineRef = useRef(null);

  useEffect(() => {
    if (mapRef.current && !leafletMap.current) {
      leafletMap.current = L.map(mapRef.current, { zoomControl: true, attributionControl: false }).setView([20, 0], 2);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "",
        maxZoom: 19,
      }).addTo(leafletMap.current);
    }
  }, []);

useEffect(() => {
  if (!leafletMap.current) return;

    // Clear old markers
    markersRef.current.forEach(m => m.remove());
    markersRef.current = [];
    if (polylineRef.current) { polylineRef.current.remove(); polylineRef.current = null; }

    if (!locations.length) return;

    const bounds = [];

    locations.forEach((loc, idx) => {
      const color = loc.visited ? "#22c55e" : "#f97316";
      const textColor = "#fff";
      const orderNum = loc.optimizedIndex !== undefined ? loc.optimizedIndex + 1 : idx + 1;

      const icon = L.divIcon({
        className: "",
        html: `<div style="
          width:32px;height:32px;
          background:${color};
          border:3px solid ${loc.visited ? "#16a34a" : "#ea580c"};
          border-radius:50% 50% 50% 0;
          transform:rotate(-45deg);
          display:flex;align-items:center;justify-content:center;
          box-shadow:0 2px 8px rgba(0,0,0,0.4);
        ">
          <span style="transform:rotate(45deg);color:${textColor};font-weight:700;font-size:11px;font-family:monospace;">${orderNum}</span>
        </div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 32],
        popupAnchor: [0, -36],
      });

      const marker = L.marker([loc.lat, loc.lng], { icon }).addTo(leafletMap.current);
      marker.bindPopup(`
        <div style="font-family:sans-serif;min-width:160px;">
          <strong style="font-size:13px;">#${orderNum} ${loc.name || "Location"}</strong><br/>
          <small style="color:#666;">${loc.address}</small><br/><br/>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button onclick="window.frpToggle('${loc.id}')" style="
              padding:4px 10px;background:${loc.visited ? "#ef4444" : "#22c55e"};
              color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px;">
              ${loc.visited ? "Mark Pending" : "Mark Visited"}
            </button>
            <a href="https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}" target="_blank"
              style="padding:4px 10px;background:#3b82f6;color:#fff;border-radius:4px;text-decoration:none;font-size:12px;">
              Navigate
            </a>
          </div>
        </div>
      `);
      bounds.push([loc.lat, loc.lng]);
      markersRef.current.push(marker);
    });

    if (route) {
      polylineRef.current = L.polyline(route, {
        color: "#f97316",
        weight: 3,
        opacity: 0.8,
        dashArray: "8,4",
      }).addTo(leafletMap.current);
    }

    if (bounds.length > 0) {
      leafletMap.current.fitBounds(bounds, { padding: [40, 40] });
    }

    // Global toggle handler for popups
    window.frpToggle = (id) => {
      onToggleVisited(id);
    };
  }, [locations, route]);

  useEffect(() => {
  const handler = () => {
    if (leafletMap.current) {
      setTimeout(() => leafletMap.current.invalidateSize(), 100);
    }
  };
  window.addEventListener('resize', handler);
  return () => window.removeEventListener('resize', handler);
}, []);

return <div ref={mapRef} style={{ width: "100%", height: "100%" }} />;
}

// ============================================================
// MAIN APP
// ============================================================
const DAYS = Array.from({ length: 12 }, (_, i) => i + 1);
const EMPTY_DAY = (day) => ({ day, locations: [], optimizedOrder: null, routeGeometry: null, totalTime: 0, totalDist: 0, updatedAt: null });

export default function App() {
  const [activeDay, setActiveDay] = useState(1);
  const [activeWeek, setActiveWeek] = useState(1); // 1 or 2
  const [dayData, setDayData] = useState(() => Object.fromEntries(DAYS.map(d => [d, EMPTY_DAY(d)])));
  const [addressInput, setAddressInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [bulkInput, setBulkInput] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [status, setStatus] = useState("");
  const [optimizing, setOptimizing] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [dbReady, setDbReady] = useState(false);
  const [mobileView, setMobileView] = useState("list"); // "list" | "map"
  const [mapFullscreen, setMapFullscreen] = useState(false);

  // Load from IndexedDB on mount
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

 // Sorted locations by optimized index
  const sortedLocs = [...currentDay.locations].sort((a, b) => {
  if (a.optimizedIndex == null && b.optimizedIndex == null) return 0;
  if (a.optimizedIndex == null) return 1;
  if (b.optimizedIndex == null) return -1;
  return a.optimizedIndex - b.optimizedIndex;
});

  const visited = currentDay.locations.filter(l => l.visited).length;
  const pending = currentDay.locations.length - visited;

const navigateNextStop = () => {
  if (!sortedLocs.length) return;

  const next = sortedLocs.find(l => !l.visited);

  if (!next) {
    setStatus("✓ All locations completed");
    return;
  }

  const url = `https://www.google.com/maps/dir/?api=1&destination=${next.lat},${next.lng}&travelmode=driving`;

  window.location.href = url;
};


  const persist = useCallback((newDayData) => {
    setDayData(newDayData);
    const d = newDayData[activeDay];
    saveDay({ ...d, updatedAt: new Date().toISOString() }).catch(console.error);
  }, [activeDay]);

  const updateCurrentDay = useCallback((updater) => {
    setDayData(prev => {
      const updated = { ...prev, [activeDay]: updater(prev[activeDay]) };
      saveDay({ ...updated[activeDay], updatedAt: new Date().toISOString() }).catch(console.error);
      return updated;
    });
  }, [activeDay]);

  const addLocation = async () => {
    const addr = addressInput.trim();
    if (!addr) return;
    // 🔥 Detect Google Maps link with coordinates
const googleMatch =
  addr.match(/place\/(-?\d+\.\d+),(-?\d+\.\d+)/) ||
  addr.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);

if (googleMatch) {
  const lat = parseFloat(googleMatch[1]);
  const lng = parseFloat(googleMatch[2]);

  const loc = {
    id: crypto.randomUUID(),
    address: "Custom Google Location",
    name: nameInput.trim() || "Shop",
    lat,
    lng,
    display: addr,
    visited: false,
    optimizedIndex: undefined,
  };

  updateCurrentDay(d => ({
    ...d,
    locations: [...d.locations, loc],
    optimizedOrder: null,
    routeGeometry: null,
  }));

  setAddressInput("");
  setNameInput("");
  setStatus("✓ Added from Google Maps link");
  return;
}
    setGeocoding(true);
    setStatus("Geocoding address...");
    try {
      const geo = await geocodeAddress(addr);
      const loc = {
        id: crypto.randomUUID(),
        address: addr,
        name: nameInput.trim() || addr.split(",")[0],
        lat: geo.lat,
        lng: geo.lng,
        display: geo.display,
        visited: false,
        optimizedIndex: undefined,
      };
      updateCurrentDay(d => ({ ...d, locations: [...d.locations, loc], optimizedOrder: null, routeGeometry: null }));
      setAddressInput("");
      setNameInput("");
      setStatus(`✓ Added: ${loc.name}`);
    } catch (e) {
      setStatus(`✗ Error: ${e.message}`);
    } finally {
      setGeocoding(false);
    }
  };

  const addBulk = async () => {
    const lines = bulkInput.trim().split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setGeocoding(true);
    setStatus(`Geocoding ${lines.length} addresses...`);
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      setStatus(`Geocoding ${i + 1}/${lines.length}...`);
      try {
        const geo = await geocodeAddress(lines[i]);
        results.push({
          id: crypto.randomUUID(),
          address: lines[i],
          name: lines[i].split(",")[0],
          lat: geo.lat,
          lng: geo.lng,
          display: geo.display,
          visited: false,
          optimizedIndex: undefined,
        });
        await new Promise(r => setTimeout(r, 1000)); // rate limit Nominatim
      } catch (e) {
        setStatus(`✗ Skipped "${lines[i]}": not found`);
        await new Promise(r => setTimeout(r, 500));
      }
    }
    updateCurrentDay(d => ({ ...d, locations: [...d.locations, ...results], optimizedOrder: null, routeGeometry: null }));
    setBulkInput("");
    setShowBulk(false);
    setStatus(`✓ Added ${results.length} locations`);
    setGeocoding(false);
  };

  const optimizeRoute = async () => {
    const locs = currentDay.locations;
    if (locs.length < 2) { setStatus("Need at least 2 locations"); return; }
    setOptimizing(true);
    setStatus("Fetching distance matrix...");
    try {
      const matrix = await getDistanceMatrix(locs);
      setStatus("Solving route...");
      const { order, totalTime } = solveTSP(matrix);
      const orderedLocs = order.map((idx, pos) => ({ ...locs[idx], optimizedIndex: pos }));
      setStatus("Fetching route geometry...");
      const routeData = await getRouteGeometry(orderedLocs);
      updateCurrentDay(d => {
  const indexMap = Object.fromEntries(
    orderedLocs.map(l => [l.id, l.optimizedIndex])
  );

  return {
    ...d,
    locations: d.locations.map(l =>
      indexMap[l.id] !== undefined
        ? { ...l, optimizedIndex: indexMap[l.id] }
        : l
    ),
    optimizedOrder: order,
    routeGeometry: routeData?.coordinates || null,
    totalTime,
    totalDist: routeData?.distance || 0,
  };
});
      setStatus(`✓ Optimized! ${fmtDist(routeData?.distance)} · ${fmtTime(routeData?.duration)}`);
    } catch (e) {
      setStatus(`✗ Optimization failed: ${e.message}`);
    } finally {
      setOptimizing(false);
    }
  };

const toggleVisited = (id) => {
  const loc = sortedLocs.find(l => l.id === id);
  if (!loc) return;
const willBeVisited = !loc.visited;

  updateCurrentDay(d => ({
    ...d,
    locations: d.locations.map(l =>
      l.id === id ? { ...l, visited: !l.visited } : l
    ),
  }));

  if (willBeVisited) {
    setTimeout(() => {
      navigateNextStop();
    }, 300);
  }
};
  const removeLocation = (id) => {
  updateCurrentDay(d => ({
    ...d,
    locations: d.locations.filter(l => l.id !== id),
    optimizedOrder: null,
    routeGeometry: null,
    totalTime: 0,
    totalDist: 0,
  }));
};

  const clearDay = () => {
    if (!confirm("Clear all locations for this day?")) return;
    updateCurrentDay(() => EMPTY_DAY(activeDay));
    setStatus("Day cleared");
  };

 
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { height: 100%; margin: 0; padding: 0; }
#root { height: 100%; display: flex; flex-direction: column; }
        body { font-family: 'Syne', sans-serif; background: #0c0f14; color: #e8e3db; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #1a1f2a; }
        ::-webkit-scrollbar-thumb { background: #f97316; border-radius: 2px; }
        
        .app { display: flex; flex-direction: column; height: 100%; overflow: hidden;}
        
        .header { 
          padding: 12px 16px 0;
          background: #0c0f14;
          border-bottom: 1px solid #1e2633;
          flex-shrink: 0;
        }
        .header-top {
          display: flex; align-items: center; justify-content: space-between;
          margin-bottom: 10px;
        }
        .logo { 
          font-size: 18px; font-weight: 800; letter-spacing: -0.5px;
          color: #f97316;
        }
        .logo span { color: #e8e3db; }
        
        .day-tabs { 
          display: flex; gap: 2px; overflow-x: auto;
          scrollbar-width: none;
        }
        .day-tabs::-webkit-scrollbar { display: none; }
        .day-tab {
          padding: 8px 18px;
          background: transparent;
          border: none;
          color: #6b7280;
          font-family: 'DM Mono', monospace;
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          white-space: nowrap;
          transition: all 0.15s;
          position: relative;
        }
        .day-tab.active {
          color: #f97316;
          border-bottom-color: #f97316;
        }
        .day-tab:hover:not(.active) { color: #9ca3af; }
        .day-tab .badge {
          display: inline-block;
          margin-left: 4px;
          background: #1e2633;
          color: #9ca3af;
          border-radius: 8px;
          padding: 1px 5px;
          font-size: 10px;
        }
        .day-tab.active .badge { background: #2c1810; color: #f97316; }
        
        .body { display: flex; flex: 1; overflow: hidden; min-height: 0; flex-direction: column; }
        
        /* LEFT PANEL */
        .left-panel {
          width: 340px;
          min-width: 300px;
          background: #0f1520;
          border-right: 1px solid #1e2633;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          flex-shrink: 0;
          min-height: 0;
        }
        
        .panel-section {
          padding: 14px 16px;
          border-bottom: 1px solid #1e2633;
        }
        
        .section-title {
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 1.5px;
          text-transform: uppercase;
          color: #4b5563;
          margin-bottom: 10px;
          font-family: 'DM Mono', monospace;
        }
        
        .input-row { display: flex; flex-direction: column; gap: 6px; }
        .input-field {
          background: #1a2030;
          border: 1px solid #2a3040;
          color: #e8e3db;
          padding: 9px 12px;
          border-radius: 6px;
          font-size: 13px;
          font-family: 'DM Mono', monospace;
          outline: none;
          transition: border-color 0.15s;
          width: 100%;
        }
        .input-field:focus { border-color: #f97316; }
        .input-field::placeholder { color: #4b5563; }
        
        textarea.input-field { resize: vertical; min-height: 80px; }
        
        .btn-row { display: flex; gap: 6px; }
        .btn {
          padding: 8px 14px;
          border: none;
          border-radius: 6px;
          font-family: 'Syne', sans-serif;
          font-weight: 700;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.15s;
          white-space: nowrap;
        }
        .btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-primary { background: #f97316; color: #0c0f14; flex: 1; }
        .btn-primary:hover:not(:disabled) { background: #fb923c; }
        .btn-secondary { background: #1e2633; color: #9ca3af; }
        .btn-secondary:hover:not(:disabled) { background: #252f42; color: #e8e3db; }
        .btn-danger { background: #1e2633; color: #ef4444; }
        .btn-danger:hover:not(:disabled) { background: #2d1616; }
        .btn-green { background: #15803d; color: #e8e3db; flex: 1; }
        .btn-green:hover:not(:disabled) { background: #16a34a; }
        
        .optimize-btn {
          width: 100%;
          padding: 12px;
          background: linear-gradient(135deg, #f97316, #ea580c);
          color: #0c0f14;
          border: none;
          border-radius: 8px;
          font-family: 'Syne', sans-serif;
          font-weight: 800;
          font-size: 14px;
          cursor: pointer;
          transition: all 0.2s;
          letter-spacing: 0.5px;
        }
        .optimize-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(249,115,22,0.4); }
        .optimize-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
        
        .stats-row {
          display: flex; gap: 8px;
        }
        .stat-box {
          flex: 1;
          background: #1a2030;
          border: 1px solid #2a3040;
          border-radius: 6px;
          padding: 8px 10px;
          text-align: center;
        }
        .stat-val { font-size: 16px; font-weight: 800; color: #f97316; font-family: 'DM Mono', monospace; }
        .stat-lbl { font-size: 10px; color: #4b5563; margin-top: 2px; text-transform: uppercase; letter-spacing: 1px; }
        
        .progress-bar {
          height: 3px; background: #1e2633; border-radius: 2px; overflow: hidden; margin: 8px 0;
        }
        .progress-fill {
          height: 100%; background: linear-gradient(90deg, #22c55e, #16a34a);
          transition: width 0.4s;
        }
        .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #f97316; border-top-color: transparent; border-radius: 50%; animation: spin 0.7s linear infinite; margin-right: 6px; vertical-align: middle; }
@keyframes spin { to { transform: rotate(360deg); } }
        .status-bar {
          padding: 8px 16px;
          font-family: 'DM Mono', monospace;
          font-size: 11px;
          color: #6b7280;
          background: #0a0d12;
          border-bottom: 1px solid #1a1f2a;
          min-height: 30px;
          flex-shrink: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        
        .location-list {
          flex: 1;
          overflow-y: auto;
          padding: 8px;
        }
        
        .loc-item {
          background: #151d2b;
          border: 1px solid #1e2633;
          border-radius: 8px;
          padding: 10px 12px;
          margin-bottom: 6px;
          display: flex;
          gap: 10px;
          align-items: flex-start;
          transition: border-color 0.15s;
          cursor: pointer;
        }
        .loc-item:hover { border-color: #2a3a50; }
        .loc-item.visited { border-color: #14532d; background: #0f1f16; opacity: 0.7; }
        
        .loc-num {
          width: 26px; height: 26px; min-width: 26px;
          border-radius: 50%;
          background: #f97316;
          color: #0c0f14;
          font-family: 'DM Mono', monospace;
          font-weight: 700;
          font-size: 11px;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }
        .loc-item.visited .loc-num { background: #22c55e; }
        .leaflet-container { 
  width: 100% !important; 
  height: 100% !important; 
}
        .loc-info { flex: 1; min-width: 0; }
        .loc-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .loc-addr { font-size: 11px; color: #4b5563; font-family: 'DM Mono', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
        
        .loc-actions { display: flex; gap: 4px; flex-shrink: 0; }
        .icon-btn {
          width: 28px; height: 28px;
          background: #1e2633;
          border: none;
          border-radius: 5px;
          cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          color: #9ca3af;
          font-size: 13px;
          transition: all 0.15s;
        }
        .icon-btn:hover { background: #2a3a50; color: #e8e3db; }
        .icon-btn.visited { background: #14532d; color: #22c55e; }
        .icon-btn.nav { background: #1e3a5f; color: #3b82f6; }
        .icon-btn.del { background: #2d1616; color: #ef4444; }
        
        .empty-state {
          padding: 40px 16px;
          text-align: center;
          color: #374151;
        }
        .empty-state-icon { font-size: 40px; margin-bottom: 12px; }
        .empty-state-text { font-size: 13px; line-height: 1.6; }
        
        /* RIGHT PANEL / MAP */
        .right-panel { 
  position: relative; 
  overflow: hidden; 
  height: 38vh;
  flex-shrink: 0;
}
.right-panel.fullscreen { 
  position: fixed; 
  top: 0; left: 0; 
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  z-index: 9999; 
}
        
        /* MOBILE */
@media (max-width: 768px) {
  .left-panel {
    flex: 1;
    width: 100%;
    min-width: unset;
    border-right: none;
    border-top: 1px solid #1e2633;
    overflow-y: auto;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .left-panel .location-list {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .left-panel.hidden { display: none; }
  .mobile-toggle { display: none; }
}
@media (min-width: 769px) {
  .right-panel { height: auto !important; flex: 1; }
}
      `}</style>

      {/* Load Leaflet */}
     
      <div className="app">
        {/* HEADER */}
        <div className="header">
          <div className="header-top">
            <div className="logo">FIELD<span>ROUTE</span></div>
            <div style={{ display: "flex", gap: 6 }}>
  <button
    className="btn btn-secondary"
    style={{ padding: "4px 10px", fontSize: 11 }}
    onClick={() => setActiveWeek(1)}
  >
    Week 1
  </button>
  <button
    className="btn btn-secondary"
    style={{ padding: "4px 10px", fontSize: 11 }}
    onClick={() => setActiveWeek(2)}
  >
    Week 2
  </button>
</div>
            <div style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "#4b5563" }}>
              {dbReady ? "● READY" : "● LOADING"}
            </div>
          </div>
          <div className="day-tabs">
            {DAYS
  .filter(d => activeWeek === 1 ? d <= 6 : d > 6)
  .map(d => (
              <button key={d} className={`day-tab ${activeDay === d ? "active" : ""}`} onClick={() => setActiveDay(d)}>
                Day {d}
                <span className="badge">{dayData[d].locations.length}</span>
              </button>
            ))}
          </div>
        </div>

        {/* STATUS BAR */}
        <div className="status-bar">
          {optimizing || geocoding ? <span className="spinner"></span> : null}
          {status || "Ready · Add locations to start planning"}
        </div>

        <div className="body" style={{ position: "relative" }}>
          {/* MAP PANEL */}
          <div className={`right-panel ${mapFullscreen ? "fullscreen" : ""}`}>
            <MapView
              locations={sortedLocs}
              route={currentDay.routeGeometry}
              onToggleVisited={toggleVisited}
            />
            <button
              onClick={() => {
  setMapFullscreen(v => !v);
  setTimeout(() => {
    window.dispatchEvent(new Event('resize'));
  if (leafletMap.current) leafletMap.current.invalidateSize();
  }, 150);
}}

              style={{
                position: "absolute", top: 10, right: 10, zIndex: 1000,
                background: "#0c0f14", border: "1px solid #f97316",
                color: "#f97316", borderRadius: 6, padding: "5px 10px",
                fontFamily: "'DM Mono', monospace", fontSize: 11,
                cursor: "pointer"
              }}
            >
              {mapFullscreen ? "✕ Exit" : "⤢ Full"}
            </button>
          </div>
          {/* LEFT PANEL */}
          <div className={`left-panel ${mobileView === "map" ? "hidden" : ""}`}>
            {/* ADD LOCATION */}
            <div className="panel-section">
              <div className="section-title">Add Location</div>
              <div className="input-row">
                <input
                  className="input-field"
                  placeholder="Shop name (optional)"
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                />
                <input
                  className="input-field"
                  placeholder="Address or place name"
                  value={addressInput}
                  onChange={e => setAddressInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && addLocation()}
                />
                <div className="btn-row">
                  <button className="btn btn-primary" onClick={addLocation} disabled={geocoding || !addressInput.trim()}>
                    {geocoding ? "Adding..." : "Add Location"}
                  </button>
                  <button className="btn btn-secondary" onClick={() => setShowBulk(v => !v)}>Bulk</button>
                </div>
                {showBulk && (
                  <>
                    <textarea
                      className="input-field"
                      placeholder={"One address per line:\nBroadway, New York\nTimes Square, NY\n..."}
                      value={bulkInput}
                      onChange={e => setBulkInput(e.target.value)}
                    />
                    <button className="btn btn-primary" onClick={addBulk} disabled={geocoding || !bulkInput.trim()}>
                      {geocoding ? "Processing..." : `Add ${bulkInput.trim().split("\n").filter(Boolean).length} Addresses`}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* STATS + OPTIMIZE */}
            <div className="panel-section">
              <div className="stats-row" style={{ marginBottom: 10 }}>
                <div className="stat-box">
                  <div className="stat-val">{currentDay.locations.length}</div>
                  <div className="stat-lbl">Total</div>
                </div>
                <div className="stat-box">
                  <div className="stat-val" style={{ color: "#22c55e" }}>{visited}</div>
                  <div className="stat-lbl">Done</div>
                </div>
                <div className="stat-box">
                  <div className="stat-val" style={{ color: "#f97316" }}>{pending}</div>
                  <div className="stat-lbl">Left</div>
                </div>
                {currentDay.totalDist > 0 && (
                  <div className="stat-box">
                    <div className="stat-val" style={{ color: "#a78bfa", fontSize: 13 }}>{fmtDist(currentDay.totalDist)}</div>
                    <div className="stat-lbl">{fmtTime(currentDay.totalTime)}</div>
                  </div>
                )}
              </div>

              {currentDay.locations.length > 1 && (
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${currentDay.locations.length ? (visited / currentDay.locations.length) * 100 : 0}%` }} />
                </div>
              )}

              <div className="btn-row" style={{ marginBottom: 8 }}>
                <button
                  className="optimize-btn"
                  onClick={optimizeRoute}
                  disabled={optimizing || currentDay.locations.length < 2}
                  style={{ flex: 1 }}
                >
                  {optimizing ? "Optimizing..." : "⚡ Optimize Route"}
                </button>
              </div>
              <div className="btn-row">
                {currentDay.optimizedOrder && (
                  <button className="btn btn-green" onClick={navigateNextStop}>
                    🗺 Navigate Next Stop
                  </button>
                )}
                <button className="btn btn-danger" onClick={clearDay}>Clear Day</button>
              </div>
            </div>

            {/* LOCATION LIST */}
            <div className="location-list">
              {sortedLocs.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-state-icon">📍</div>
                  <div className="empty-state-text">No locations yet.<br />Add addresses above to plan your route.</div>
                </div>
              ) : (
                sortedLocs.map((loc, idx) => (
                  <div key={loc.id} className={`loc-item ${loc.visited ? "visited" : ""}`}>
                    <div className="loc-num">{idx + 1}</div>
                    <div className="loc-info">
                      <div className="loc-name">{loc.name}</div>
                      <div className="loc-addr">{loc.address}</div>
                    </div>
                    <div className="loc-actions">
                      <button
                        className={`icon-btn ${loc.visited ? "visited" : ""}`}
                        title={loc.visited ? "Mark pending" : "Mark visited"}
                        onClick={() => toggleVisited(loc.id)}
                      >
                        {loc.visited ? "✓" : "○"}
                      </button>
                      <a
                        href={`https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="icon-btn nav"
                        title="Navigate"
                        style={{ textDecoration: "none" }}
                      >
                        ↗
                      </a>
                      <button className="icon-btn del" title="Remove" onClick={() => removeLocation(loc.id)}>×</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}