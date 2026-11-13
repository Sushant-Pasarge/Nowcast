
import { useEffect, useState } from "react";

import {
  MapContainer,
  TileLayer,
  Circle,
  Popup,
  Polyline,
  useMap,
} from "react-leaflet";

import "leaflet/dist/leaflet.css";

// Automatically move map when selected location changes
function MapFlyTo({ center }) {
  const map = useMap();

  useEffect(() => {
    map.flyTo(center, 10, {
      animate: true,
      duration: 1.5,
    });
  }, [center[0], center[1], map]);

  return null;
}

export default function MapComponent({
  riskData,
  isLightMode = false,
  isRadarOn = true,
}) {
  const [radarUrl, setRadarUrl] = useState(null);
  const [radarError, setRadarError] = useState(false);
  const [radarLoading, setRadarLoading] = useState(true);
  const [activeLayer, setActiveLayer] = useState("risk");

  // Fetch latest RainViewer radar frame
  useEffect(() => {
    let cancelled = false;

    const fetchRadar = async () => {
      try {
        setRadarLoading(true);

        const response = await fetch(
          "https://api.rainviewer.com/public/weather-maps.json",
          { cache: "no-store" }
        );

        if (!response.ok) {
          throw new Error(`RainViewer API error: ${response.status}`);
        }

        const data = await response.json();

        const frames = data?.radar?.past || [];
        const latestFrame = frames[frames.length - 1];

        if (!latestFrame?.path) {
          throw new Error("No radar frames available");
        }

        // RainViewer tile URL
        const host =
          data.host || "https://tilecache.rainviewer.com";

        const tileUrl =
          `${host}${latestFrame.path}/256/{z}/{x}/{y}/2/1_1.png`;

        if (!cancelled) {
          setRadarUrl(tileUrl);
          setRadarError(false);
        }
      } catch (error) {
        console.error("RainViewer radar error:", error);

        if (!cancelled) {
          setRadarError(true);
        }
      } finally {
        if (!cancelled) {
          setRadarLoading(false);
        }
      }
    };

    fetchRadar();

    const interval = setInterval(fetchRadar, 300000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // Selected location
  const center = [
    riskData?.latitude ?? 12.9716,
    riskData?.longitude ?? 77.5946,
  ];

  // Risk zone colors
  const getRiskColor = (level) => {
    switch (String(level || "").toLowerCase()) {
      case "severe":
        return "#dc2626";
      case "high":
        return "#f97316";
      case "moderate":
        return "#eab308";
      default:
        return "#22c55e";
    }
  };

  // Illustrative storm movement line
  const movementVector = [
    [center[0] - 0.05, center[1] - 0.05],
    [center[0] + 0.05, center[1] + 0.05],
  ];

  const mapBgColor = isLightMode ? "#f8fafc" : "#0B1120";

  return (
    <div
      className="relative w-full h-full min-h-[400px]"
      style={{ backgroundColor: mapBgColor }}
    >
      <MapContainer
        center={center}
        zoom={10}
        scrollWheelZoom={true}
        style={{
          height: "100%",
          minHeight: "400px",
          width: "100%",
          background: mapBgColor,
        }}
      >
        <MapFlyTo center={center} />

        {/* NORMAL MAP - Risk and Radar */}
        {(activeLayer === "risk" || activeLayer === "radar") && (
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={19}
          />
        )}

        {/* SATELLITE BASE MAP */}
        {activeLayer === "satellite" && (
          <TileLayer
            attribution='Tiles &copy; <a href="https://www.esri.com/">Esri</a>'
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            maxZoom={19}
          />
        )}

        {/* RAINVIEWER RADAR OVERLAY */}
        {activeLayer === "radar" &&
          isRadarOn &&
          radarUrl && (
            <TileLayer
              key={radarUrl}
              url={radarUrl}
              opacity={0.75}
              zIndex={10}
              maxZoom={12}
              attribution='Radar &copy; <a href="https://www.rainviewer.com/">RainViewer</a>'
            />
          )}

        {/* RISK ZONES */}
        {activeLayer === "risk" &&
          riskData?.map_zones?.map((zone, index) => (
            <Circle
              key={index}
              center={[zone.lat, zone.lng]}
              radius={zone.radius}
              pathOptions={{
                color: getRiskColor(zone.level),
                fillColor: getRiskColor(zone.level),
                fillOpacity: 0.25,
                weight: 2,
              }}
            >
              <Popup>
                <strong>{zone.level} Risk Zone</strong>
                <br />
                Radius: {zone.radius} metres
              </Popup>
            </Circle>
          ))}

        {/* STORM MOVEMENT */}
        {riskData?.storm_movement && (
          <Polyline
            positions={movementVector}
            pathOptions={{
              color: "#6366f1",
              weight: 4,
              dashArray: "8, 8",
            }}
          >
            <Popup>
              <strong>Storm Movement</strong>
              <br />
              Direction: {riskData.storm_movement.direction}
              <br />
              Speed: {riskData.storm_movement.speed_kmh} km/h
            </Popup>
          </Polyline>
        )}
      </MapContainer>

      {/* MAP LAYER CONTROLS */}
      <div
        className={`absolute top-4 right-4 z-[400] p-3 rounded-lg border shadow-lg ${
          isLightMode
            ? "bg-white/95 border-slate-200 text-slate-800"
            : "bg-[#111827]/95 border-slate-700 text-white"
        }`}
      >
        <p className="font-bold text-xs mb-3">MAP LAYERS</p>

        <div className="flex flex-col gap-3 text-xs">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="map-layer"
              checked={activeLayer === "risk"}
              onChange={() => setActiveLayer("risk")}
            />
            Risk Zones
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="map-layer"
              checked={activeLayer === "radar"}
              onChange={() => setActiveLayer("radar")}
            />
            Radar
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="map-layer"
              checked={activeLayer === "satellite"}
              onChange={() => setActiveLayer("satellite")}
            />
            Satellite
          </label>
        </div>

        {/* RADAR STATUS */}
        {activeLayer === "radar" && (
          <p className="text-[10px] mt-3 text-slate-400">
            {!isRadarOn
              ? "Radar sync is disabled in Settings."
              : radarLoading
              ? "Loading radar frames..."
              : radarError
              ? "Radar data unavailable. Try again later."
              : radarUrl
              ? "Latest available radar frame loaded."
              : "No radar frame available."}
          </p>
        )}

        {/* SATELLITE STATUS */}
        {activeLayer === "satellite" && (
          <p className="text-[10px] mt-3 text-slate-400">
            Satellite imagery powered by Esri.
          </p>
        )}
      </div>

      {/* RISK LEGEND */}
      {activeLayer === "risk" && (
        <div
          className={`absolute bottom-4 right-4 z-[400] p-3 rounded-lg border shadow-lg text-xs ${
            isLightMode
              ? "bg-white/95 border-slate-200 text-slate-800"
              : "bg-[#111827]/95 border-slate-700 text-slate-300"
          }`}
        >
          <p className="font-bold mb-2">RISK LEVEL</p>

          {[
            ["#dc2626", "Severe Risk"],
            ["#f97316", "High Risk"],
            ["#eab308", "Moderate Risk"],
            ["#22c55e", "Low Risk"],
          ].map(([color, label]) => (
            <div
              key={label}
              className="flex items-center gap-2 mb-2 last:mb-0"
            >
              <span
                className="w-3 h-3 rounded-sm"
                style={{ backgroundColor: color }}
              />
              {label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
