
import { useEffect, useState } from "react";

import {
  Thermometer,
  Droplets,
  Gauge,
  Wind,
  Navigation,
  CloudRain,
  Zap,
  Activity,
  Database,
  Server,
  Layers,
  PlayCircle,
  CheckCircle,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

import MapComponent from "./MapComponent";

const RAINVIEWER_API =
  "https://api.rainviewer.com/public/weather-maps.json";

function getTileCoordinates(latitude, longitude, zoom) {
  const n = Math.pow(2, zoom);

  const lat = Math.max(
    -85.05112878,
    Math.min(85.05112878, latitude)
  );

  const x = Math.floor(((longitude + 180) / 360) * n);

  const latRad = (lat * Math.PI) / 180;

  const y = Math.floor(
    ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n
  );

  return {
    x: Math.max(0, Math.min(n - 1, x)),
    y: Math.max(0, Math.min(n - 1, y)),
  };
}

function formatRadarTime(timestamp) {
  return new Date(timestamp * 1000).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function DashboardView({
  riskData,
  trendData = [],
  isLightMode = false,
  isRadarOn = false,
}) {
  const [radarTimeline, setRadarTimeline] = useState([]);
  const [radarLoading, setRadarLoading] = useState(true);
  const [radarError, setRadarError] = useState("");
  const [liveTime, setLiveTime] = useState("");

  // ------------------------------------
  // LIVE CLOCK
  // ------------------------------------

  useEffect(() => {
    const updateTime = () => {
      setLiveTime(
        new Date().toLocaleTimeString("en-IN", {
          hour12: false,
        })
      );
    };

    updateTime();

    const timer = setInterval(updateTime, 1000);

    return () => clearInterval(timer);
  }, []);

  // ------------------------------------
  // FETCH RAINVIEWER RADAR TIMELINE
  // ------------------------------------

  useEffect(() => {
    let cancelled = false;

    const fetchRadarTimeline = async () => {
      if (!riskData) {
        setRadarTimeline([]);
        setRadarLoading(false);
        return;
      }

      try {
        setRadarLoading(true);
        setRadarError("");

        const response = await fetch(RAINVIEWER_API);

        if (!response.ok) {
          throw new Error(
            `RainViewer API returned ${response.status}`
          );
        }

        const data = await response.json();

        const frames = data.radar?.past || [];

        if (!data.host || frames.length === 0) {
          throw new Error("No historical radar frames available.");
        }

        const latitude = Number(riskData.latitude);
        const longitude = Number(riskData.longitude);

        if (
          !Number.isFinite(latitude) ||
          !Number.isFinite(longitude)
        ) {
          throw new Error("Invalid map coordinates.");
        }

        const zoom = 6;

        const { x, y } = getTileCoordinates(
          latitude,
          longitude,
          zoom
        );

        // Use the latest five frames returned by RainViewer.
        const latestFrames = frames.slice(-5);

        const timeline = latestFrames.map((frame) => {
          // RainViewer supplies the complete radar path.
          const radarPath = frame.path;

          if (!radarPath || !frame.time) {
            return null;
          }

          const cleanHost = data.host.replace(/\/$/, "");
          const cleanPath = radarPath.startsWith("/")
            ? radarPath
            : `/${radarPath}`;

          const baseMapUrl =
            `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;

          const radarImageUrl =
            `${cleanHost}${cleanPath}/256/${zoom}/${x}/${y}/2/1_1.png`;

          return {
            time: formatRadarTime(frame.time),
            timestamp: frame.time,
            baseMapUrl,
            radarImageUrl,
          };
        }).filter(Boolean);

        if (!cancelled) {
          setRadarTimeline(timeline);

          if (timeline.length === 0) {
            setRadarError("No valid radar frames received.");
          }
        }
      } catch (error) {
        console.error("Radar timeline error:", error);

        if (!cancelled) {
          setRadarTimeline([]);
          setRadarError(
            error.message || "Unable to load radar timeline."
          );
        }
      } finally {
        if (!cancelled) {
          setRadarLoading(false);
        }
      }
    };

    fetchRadarTimeline();

    // Refresh RainViewer timeline every five minutes.
    const interval = setInterval(fetchRadarTimeline, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [riskData?.latitude, riskData?.longitude]);

  // ------------------------------------
  // WAIT FOR BACKEND DATA
  // ------------------------------------

  if (!riskData) {
    return (
      <div className="p-8 text-center text-slate-400">
        <Activity
          size={35}
          className="mx-auto mb-3 animate-pulse text-indigo-400"
        />
        Waiting for weather prediction data...
      </div>
    );
  }

  // ------------------------------------
  // READ BACKEND RESPONSE
  // ------------------------------------

  const currentWeather = riskData.current_weather || {};
  const prediction = riskData.prediction_details || {};
  const stormMovement = riskData.storm_movement || {};
  const aiStatus = riskData.ai_status || {};

  const thunderstormProbability = Number(
    prediction.thunderstorm_probability ?? 0
  );

  const lightningProbability = Number(
    prediction.lightning_probability ?? 0
  );

  const confidence = Number(
    prediction.confidence_percent ?? 0
  );

  const riskLevel = prediction.risk_level || "Unknown";

  const stormSpeed = Number(stormMovement.speed_kmh ?? 0);

  // Do not display an invented storm arrival estimate.
  const etaMinutes = "Not available";

  // ------------------------------------
  // RISK ALERT CONFIGURATION
  // ------------------------------------

  const alertConfig = {
    Severe: {
      bg: "bg-red-900/40",
      border: "border-red-900",
      text: "text-red-500",
      icon: AlertTriangle,
      title: "Severe Weather Warning",
      desc: "Critical risk in your area. Seek shelter immediately.",
    },

    High: {
      bg: "bg-orange-900/40",
      border: "border-orange-900",
      text: "text-orange-500",
      icon: AlertTriangle,
      title: "High Risk Alert",
      desc: "Strong chances of storm formation. Stay alert.",
    },

    Moderate: {
      bg: "bg-yellow-900/20",
      border: "border-yellow-900",
      text: "text-yellow-500",
      icon: Activity,
      title: "Moderate Risk",
      desc: "Conditions are favorable for storm development.",
    },

    Low: {
      bg: "bg-emerald-900/20",
      border: "border-emerald-900",
      text: "text-emerald-500",
      icon: CheckCircle,
      title: "No Severe Alert",
      desc: "No severe risk in your area. Stay safe!",
    },
  };

  const activeAlert = alertConfig[riskLevel] || {
    bg: "bg-slate-800/40",
    border: "border-slate-700",
    text: "text-slate-400",
    icon: Activity,
    title: "Risk Status Unavailable",
    desc: "Unable to determine the current weather risk.",
  };

  const AlertIcon = activeAlert.icon;

  // ------------------------------------
  // MODEL STATUS
  // ------------------------------------

  const getModelStatus = (status) => {
    if (typeof status !== "string") {
      return "Unavailable";
    }

    return status.startsWith("Active")
      ? "Active"
      : "Unavailable";
  };

  const fusionConnected =
    typeof aiStatus.data_sources === "string" &&
    aiStatus.data_sources.toLowerCase().includes("connected");

  // ------------------------------------
  // THEME
  // ------------------------------------

  const bgCard = isLightMode
    ? "bg-white border-slate-200 shadow-sm"
    : "bg-[#111827] border-slate-800";

  const textMain = isLightMode
    ? "text-slate-900"
    : "text-white";

  const textSub = isLightMode
    ? "text-slate-500"
    : "text-slate-400";

  const textMuted = isLightMode
    ? "text-slate-600"
    : "text-slate-300";

  const borderColor = isLightMode
    ? "border-slate-200"
    : "border-slate-800";

  const safePercentage = (value) =>
    Math.min(100, Math.max(0, Number(value) || 0));

  // ------------------------------------
  // DATA SOURCES
  // ------------------------------------

  const dataSources = [
    {
      icon: Activity,
      color: "text-blue-500",
      name: "Radar Data",
      source: "IMD",
    },
    {
      icon: Database,
      color: "text-slate-400",
      name: "Satellite Data",
      source: "INSAT-3D",
    },
    {
      icon: Zap,
      color: "text-yellow-500",
      name: "Lightning",
      source: "Earth Networks",
    },
    {
      icon: CloudRain,
      color: "text-sky-500",
      name: "Atmospheric",
      source: "IMD Observations",
    },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 pb-10 transition-colors duration-300">

      {/* CURRENT WEATHER */}

      <div
        className={`col-span-1 lg:col-span-3 border rounded-xl p-4 md:p-5 flex flex-col justify-between ${bgCard}`}
      >
        <h3 className={`text-xs font-bold ${textSub} uppercase tracking-wider mb-2 flex items-center gap-2`}>
          Current Conditions
          <Activity size={14} />
        </h3>

        <div className="flex-grow flex flex-col items-end justify-center py-4">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-indigo-400" />

            <span className="text-3xl md:text-4xl font-mono font-bold text-indigo-400 tracking-widest">
              {liveTime || "00:00:00"}
            </span>
          </div>

          <p className={`text-[9px] ${textSub} uppercase tracking-widest mt-1`}>
            Live Local Time
          </p>
        </div>

        <div className="space-y-3 md:space-y-4">
          <div className="flex justify-between items-center">
            <div className={`flex items-center gap-2 ${textMuted} text-sm`}>
              <Thermometer size={16} className="text-red-400" />
              Temperature
            </div>

            <div className={`font-bold ${textMain}`}>
              {currentWeather.temperature_celsius ?? "N/A"} °C
            </div>
          </div>

          <div className="flex justify-between items-center">
            <div className={`flex items-center gap-2 ${textMuted} text-sm`}>
              <Droplets size={16} className="text-blue-400" />
              Humidity
            </div>

            <div className={`font-bold ${textMain}`}>
              {currentWeather.humidity_percent ?? "N/A"} %
            </div>
          </div>

          <div className="flex justify-between items-center">
            <div className={`flex items-center gap-2 ${textMuted} text-sm`}>
              <Gauge size={16} className="text-emerald-400" />
              Pressure
            </div>

            <div className={`font-bold ${textMain}`}>
              {currentWeather.pressure_hpa ?? "N/A"} hPa
            </div>
          </div>

          <div className="flex justify-between items-center">
            <div className={`flex items-center gap-2 ${textMuted} text-sm`}>
              <Wind size={16} className="text-sky-400" />
              Wind Speed
            </div>

            <div className={`font-bold ${textMain}`}>
              {stormMovement.speed_kmh ?? "N/A"} km/h
            </div>
          </div>

          <div className="flex justify-between items-center">
            <div className={`flex items-center gap-2 ${textMuted} text-sm`}>
              <Navigation size={16} className="text-indigo-400" />
              Wind Direction
            </div>

            <div className={`font-bold ${textMain}`}>
              {stormMovement.direction ?? "N/A"}
            </div>
          </div>

          <div className="flex justify-between items-center">
            <div className={`flex items-center gap-2 ${textMuted} text-sm`}>
              <CloudRain size={16} className="text-slate-400" />
              Rainfall
            </div>

            <div className={`font-bold ${textMain}`}>
              {currentWeather.rainfall_mm != null
                ? `${currentWeather.rainfall_mm} mm`
                : "N/A"}
            </div>
          </div>
        </div>
      </div>

      {/* NOWCAST PREDICTION */}

      <div
        className={`col-span-1 lg:col-span-4 border rounded-xl p-4 md:p-5 ${bgCard}`}
      >
        <h3 className={`text-xs font-bold ${textSub} uppercase tracking-wider mb-4 md:mb-6 flex items-center gap-2`}>
          Nowcast Prediction
          <Zap size={14} />
        </h3>

        <div className="flex justify-between items-start mb-6">
          <div className="flex-1">
            <div className={`flex items-center gap-2 ${textMuted} mb-1 text-sm`}>
              <CloudRain size={16} />
              Thunderstorm Probability
            </div>

            <div className="text-3xl md:text-4xl font-bold text-orange-500">
              {thunderstormProbability.toFixed(2)}%
            </div>

            <div className={`w-full ${isLightMode ? "bg-slate-200" : "bg-slate-800"} h-2 rounded-full mt-3 overflow-hidden`}>
              <div
                className="bg-orange-500 h-full rounded-full"
                style={{
                  width: `${safePercentage(thunderstormProbability)}%`,
                }}
              />
            </div>

            <div className={`flex justify-between text-[10px] ${textSub} mt-1`}>
              <span>0%</span>
              <span>100%</span>
            </div>
          </div>

          <div className="text-right ml-3">
            <p className={`text-[10px] ${textSub} uppercase mb-1`}>
              Risk Level
            </p>

            <div className={`border ${activeAlert.border} ${activeAlert.text} px-2 py-1 rounded-md font-bold flex items-center gap-1 text-xs`}>
              {riskLevel.toUpperCase()}
              <AlertIcon size={14} />
            </div>
          </div>
        </div>

        <div className={`flex flex-col sm:flex-row justify-between items-start pt-4 border-t ${borderColor} gap-4`}>
          <div className={`w-full sm:w-1/2 sm:pr-4 sm:border-r ${borderColor}`}>
            <div className={`flex items-center gap-2 ${textMuted} mb-1 text-sm`}>
              <Zap size={16} className="text-yellow-400" />
              Lightning Probability
            </div>

            <div className="text-2xl md:text-3xl font-bold text-yellow-400">
              {lightningProbability.toFixed(2)}%
            </div>

            <div className={`w-full ${isLightMode ? "bg-slate-200" : "bg-slate-800"} h-2 rounded-full mt-3 overflow-hidden`}>
              <div
                className="bg-yellow-400 h-full rounded-full"
                style={{
                  width: `${safePercentage(lightningProbability)}%`,
                }}
              />
            </div>

            <div className={`flex justify-between text-[10px] ${textSub} mt-1`}>
              <span>0%</span>
              <span>100%</span>
            </div>
          </div>

          <div className="w-full sm:w-1/2 sm:pl-4 flex flex-row sm:flex-col justify-between sm:gap-4">
            <div>
              <p className={`text-[10px] ${textSub} uppercase`}>
                Confidence
              </p>

              <p className={`text-lg md:text-xl font-bold ${textMain}`}>
                {confidence}%
              </p>
            </div>

            <div>
              <p className={`text-[10px] ${textSub} uppercase`}>
                Forecast Window
              </p>

              <p className={`text-xs md:text-sm font-bold ${textMain}`}>
                {prediction.forecast_window ?? "N/A"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* LIVE SPATIAL RISK MAP */}

      <div className={`col-span-1 lg:col-span-5 border rounded-xl overflow-hidden flex flex-col min-h-[300px] ${bgCard}`}>
        <div className={`p-3 border-b flex justify-between items-center ${borderColor}`}>
          <h3 className={`text-xs font-bold ${textSub} uppercase tracking-wider flex items-center gap-2`}>
            Live Spatial Risk Map
            <Navigation size={14} />
          </h3>
        </div>

        <div className="flex-grow relative h-[300px] lg:h-auto">
          <MapComponent
            riskData={riskData}
            isLightMode={isLightMode}
          />
        </div>
      </div>

      {/* AI MODEL STATUS */}

      <div className={`col-span-1 lg:col-span-3 border rounded-xl p-4 md:p-5 ${bgCard}`}>
        <h3 className={`text-xs font-bold ${textSub} uppercase tracking-wider mb-4`}>
          AI Model Status
        </h3>

        <div className="space-y-4">

          {/* ConvLSTM */}

          <div className="flex items-center gap-3">
            <div className="bg-blue-500/20 p-2 rounded-lg text-blue-500">
              <Layers size={20} />
            </div>

            <div className="flex-grow">
              <div className="flex justify-between gap-2">
                <p className={`text-sm font-bold ${textMain}`}>
                  ConvLSTM
                  <span className={`text-xs ${textSub} font-normal`}>
                    {" "}(Radar)
                  </span>
                </p>

                <span className={`text-xs ${getModelStatus(aiStatus.convlstm) === "Active" ? "text-emerald-500" : "text-yellow-500"}`}>
                  {getModelStatus(aiStatus.convlstm)}
                </span>
              </div>

              <p className={`text-[10px] ${textSub}`}>
                {aiStatus.convlstm ?? "Status unavailable"}
              </p>
            </div>
          </div>

          {/* XGBoost */}

          <div className="flex items-center gap-3">
            <div className="bg-indigo-500/20 p-2 rounded-lg text-indigo-500">
              <Database size={20} />
            </div>

            <div className="flex-grow">
              <div className="flex justify-between gap-2">
                <p className={`text-sm font-bold ${textMain}`}>
                  XGBoost
                  <span className={`text-xs ${textSub} font-normal`}>
                    {" "}(Atmos)
                  </span>
                </p>

                <span className={`text-xs ${getModelStatus(aiStatus.xgboost) === "Active" ? "text-emerald-500" : "text-yellow-500"}`}>
                  {getModelStatus(aiStatus.xgboost)}
                </span>
              </div>

              <p className={`text-[10px] ${textSub}`}>
                {aiStatus.xgboost ?? "Status unavailable"}
              </p>
            </div>
          </div>

          {/* Fusion Engine */}

          <div className={`flex items-center gap-3 pt-3 border-t ${borderColor}`}>
            <div className="bg-purple-500/20 p-2 rounded-lg text-purple-500">
              <Server size={20} />
            </div>

            <div className="flex-grow">
              <div className="flex justify-between gap-2">
                <p className={`text-sm font-bold ${textMain}`}>
                  Fusion Engine
                </p>

                <span className={`text-xs ${fusionConnected ? "text-emerald-500" : "text-yellow-500"}`}>
                  {fusionConnected ? "Connected" : "Unavailable"}
                </span>
              </div>

              <p className={`text-[10px] ${textSub}`}>
                {aiStatus.data_sources ?? "Status unavailable"}
              </p>

              <p className={`text-[10px] ${textSub}`}>
                Last Prediction: {aiStatus.last_prediction ?? "N/A"}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* DATA SOURCE STATUS */}

      <div className={`col-span-1 lg:col-span-3 border rounded-xl p-4 md:p-5 ${bgCard}`}>
        <h3 className={`text-xs font-bold ${textSub} uppercase tracking-wider mb-4`}>
          Data Source Status
        </h3>

        <div className="space-y-3">
          {dataSources.map((item) => (
            <div
              key={item.name}
              className="flex justify-between items-center"
            >
              <div className="flex items-center gap-3">
                <item.icon
                  size={16}
                  className={`${item.color} shrink-0`}
                />

                <div>
                  <p className={`text-xs font-bold ${textMuted}`}>
                    {item.name}
                  </p>

                  <p className={`text-[10px] ${textSub}`}>
                    {item.source}
                  </p>
                </div>
              </div>

              <span className="text-[10px] text-slate-400">
                Not verified
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* STORM MOVEMENT */}

      <div className={`col-span-1 lg:col-span-3 border rounded-xl p-4 md:p-5 ${bgCard}`}>
        <h3 className={`text-xs font-bold ${textSub} uppercase tracking-wider mb-4`}>
          Storm Movement
        </h3>

        <div className="space-y-4 flex flex-row lg:flex-col justify-between items-center lg:items-stretch">
          <div className="flex items-center gap-3 md:gap-4">
            <Navigation
              size={24}
              className="text-slate-400 rotate-45"
            />

            <div>
              <p className={`text-[10px] ${textSub} uppercase`}>
                Direction
              </p>

              <p className={`text-base md:text-lg font-bold ${textMain}`}>
                {stormMovement.direction ?? "N/A"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 md:gap-4">
            <Wind size={24} className="text-slate-400" />

            <div>
              <p className={`text-[10px] ${textSub} uppercase`}>
                Speed
              </p>

              <p className={`text-base md:text-lg font-bold ${textMain}`}>
                {Number.isFinite(stormSpeed)
                  ? `${stormSpeed} km/h`
                  : "N/A"}
              </p>
            </div>
          </div>
        </div>

        <div className={`flex items-center gap-3 md:gap-4 mt-4 pt-3 border-t ${borderColor}`}>
          <Activity size={20} className="text-slate-400" />

          <div>
            <p className={`text-[10px] ${textSub} uppercase`}>
              Estimated Arrival
            </p>

            <p className={`text-sm font-bold ${textMain}`}>
              {etaMinutes}
            </p>
          </div>
        </div>
      </div>

      {/* ALERTS */}

      <div className={`col-span-1 lg:col-span-3 ${activeAlert.bg} border ${activeAlert.border} rounded-xl p-4 md:p-5 flex flex-col justify-center items-center text-center`}>
        <h3 className={`text-xs font-bold ${activeAlert.text} uppercase tracking-wider mb-4 self-start w-full text-left`}>
          Alerts
        </h3>

        <div className={`h-12 w-12 md:h-16 md:w-16 rounded-full border-2 ${activeAlert.text} flex items-center justify-center mb-4`}>
          <AlertIcon size={24} />
        </div>

        <p className={`${activeAlert.text} font-bold text-base md:text-lg mb-1`}>
          {activeAlert.title}
        </p>

        <p className={`${activeAlert.text} opacity-80 text-xs`}>
          {activeAlert.desc}
        </p>
      </div>

      {/* RADAR TIMELINE */}

      <div className={`col-span-1 lg:col-span-6 border rounded-xl p-4 md:p-5 ${bgCard}`}>
        <div className="flex justify-between items-center gap-2 mb-4">
          <h3 className={`text-xs font-bold ${textSub} uppercase tracking-wider flex items-center gap-2`}>
            Radar Nowcast Timeline
            <PlayCircle size={14} className="text-indigo-500" />
          </h3>

          <span className={`text-[10px] ${isRadarOn ? "text-emerald-500" : "text-yellow-500"}`}>
            Sync {isRadarOn ? "Enabled" : "Disabled"}
          </span>
        </div>

        {radarLoading ? (
          <div className="flex justify-center items-center py-12 gap-2">
            <RefreshCw
              size={16}
              className="animate-spin text-indigo-500"
            />

            <span className={`text-xs ${textSub}`}>
              Loading radar frames...
            </span>
          </div>
        ) : radarTimeline.length > 0 ? (
          <div className="flex justify-between items-center gap-3 overflow-x-auto pb-2">
            {radarTimeline.map((frame, index) => (
              <div
                key={frame.timestamp}
                className="flex-none w-20 md:flex-1 flex flex-col items-center"
              >
                <div
                  className={`w-full aspect-square rounded-lg mb-2 border relative overflow-hidden ${
                    index === radarTimeline.length - 1
                      ? "border-indigo-500"
                      : isLightMode
                      ? "border-slate-300"
                      : "border-slate-700"
                  }`}
                >
                  {/* Background map tile */}
                  <img
                    src={frame.baseMapUrl}
                    alt={`Map at ${frame.time}`}
                    className="absolute inset-0 w-full h-full object-cover"
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />

                  {/* Radar overlay */}
                  <img
                    src={frame.radarImageUrl}
                    alt={`Radar at ${frame.time}`}
                    className="absolute inset-0 w-full h-full object-cover"
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />

                  <span className="absolute bottom-1 right-1 text-[8px] bg-black/60 text-white px-1 rounded">
                    Radar
                  </span>
                </div>

                <p className={`text-[10px] ${textSub}`}>
                  {index === radarTimeline.length - 1
                    ? "LATEST"
                    : frame.time}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="w-full flex flex-col items-center justify-center py-8">
            <CloudRain
              size={28}
              className="mb-2 text-slate-500"
            />

            <p className={`text-xs ${textSub}`}>
              {radarError || "Radar timeline unavailable."}
            </p>

            <p className="text-[10px] text-slate-500 mt-2">
              Check your internet connection or RainViewer availability.
            </p>
          </div>
        )}

        <p className={`text-[10px] ${textSub} mt-3`}>
          Radar imagery provided by RainViewer. Frames refresh every five minutes.
        </p>
      </div>

      {/* PREDICTION TREND */}

      <div className={`col-span-1 lg:col-span-6 border rounded-xl p-4 md:p-5 ${bgCard}`}>
        <h3 className={`text-xs font-bold ${textSub} uppercase tracking-wider mb-4`}>
          Prediction Trend
          <span className="text-slate-500 normal-case">
            {" "}(SQLite Prediction History)
          </span>
        </h3>

        <div className="flex items-center gap-4 mb-3 text-[10px]">
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-orange-500" />
            <span className={textSub}>Thunderstorm</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-yellow-400" />
            <span className={textSub}>Lightning</span>
          </div>
        </div>

        <div className="h-40 w-full">
          {trendData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={trendData}
                margin={{
                  top: 5,
                  right: 10,
                  left: -20,
                  bottom: 0,
                }}
              >
                <XAxis
                  dataKey="time"
                  stroke="#94a3b8"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                />

                <YAxis
                  stroke="#94a3b8"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  domain={[0, 100]}
                  tickFormatter={(value) => `${value}%`}
                />

                <Tooltip
                  contentStyle={{
                    backgroundColor: isLightMode
                      ? "#ffffff"
                      : "#1e293b",
                    border: isLightMode
                      ? "1px solid #e2e8f0"
                      : "1px solid #334155",
                    borderRadius: "8px",
                    fontSize: "12px",
                    color: isLightMode ? "#0f172a" : "#fff",
                  }}
                  formatter={(value, name) => [
                    `${value}%`,
                    name === "thunder"
                      ? "Thunderstorm"
                      : "Lightning",
                  ]}
                />

                <Line
                  type="monotone"
                  dataKey="thunder"
                  name="Thunderstorm"
                  stroke="#f97316"
                  strokeWidth={2}
                  dot={{ r: 4, fill: "#f97316" }}
                  activeDot={{ r: 6 }}
                />

                <Line
                  type="monotone"
                  dataKey="lightning"
                  name="Lightning"
                  stroke="#facc15"
                  strokeWidth={2}
                  dot={{ r: 4, fill: "#facc15" }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className={`h-full flex items-center justify-center text-xs ${textSub}`}>
              No prediction history available yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
