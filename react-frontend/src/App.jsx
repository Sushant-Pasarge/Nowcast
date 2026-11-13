
import { useState, useEffect, useCallback } from "react";

import {
  LayoutDashboard,
  MapPin,
  Bell,
  Settings,
  Database,
  Menu,
  X,
  RefreshCw,
  Wifi,
  WifiOff,
  Search,
} from "lucide-react";

import DashboardView from "./components/DashboardView";
import MapComponent from "./components/MapComponent";
import AlertsView from "./components/AlertsView";
import DataSourcesView from "./components/DataSourcesView";
import SettingsView from "./components/SettingsView";

import "./App.css";

// =====================================================
// API CONFIGURATION
// =====================================================

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000";

const DEFAULT_LOCATION = {
  name: "Bengaluru",
  lat: 12.9716,
  lon: 77.5946,
};

// =====================================================
// MAIN APP
// =====================================================

function App() {

  // Location
  const [location, setLocation] = useState(DEFAULT_LOCATION.name);

  const [selectedLocation, setSelectedLocation] = useState(
    DEFAULT_LOCATION
  );

  const [searchingLocation, setSearchingLocation] = useState(false);
  const [locationError, setLocationError] = useState("");

  // Navigation
  const [activePage, setActivePage] = useState("Dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Theme
  const [isLightMode, setIsLightMode] = useState(false);

  // Radar
  const [isRadarOn, setIsRadarOn] = useState(false);
  const [radarLoading, setRadarLoading] = useState(true);
  const [radarUpdating, setRadarUpdating] = useState(false);

  // Backend data
  const [riskData, setRiskData] = useState(null);
  const [trendData, setTrendData] = useState([]);

  // Backend status
  const [loading, setLoading] = useState(true);
  const [backendConnected, setBackendConnected] = useState(false);
  const [apiError, setApiError] = useState("");
  const [lastFetched, setLastFetched] = useState(null);


  // =====================================================
  // FETCH WEATHER AND PREDICTION HISTORY
  // =====================================================

  const fetchDashboardData = useCallback(
    async (showLoading = false) => {

      if (showLoading) {
        setLoading(true);
      }

      try {

        const params = new URLSearchParams({
          lat: String(selectedLocation.lat),
          lon: String(selectedLocation.lon),
        });

        const [riskResponse, historyResponse] = await Promise.all([
          fetch(
            `${API_BASE_URL}/api/realtime-risk?${params.toString()}`
          ),

          fetch(
            `${API_BASE_URL}/api/history?${params.toString()}`
          ),
        ]);

        if (!riskResponse.ok) {
          const errorData = await riskResponse.json().catch(() => ({}));

          throw new Error(
            errorData.detail ||
            `Realtime API error: ${riskResponse.status}`
          );
        }

        const realtimeData = await riskResponse.json();

        setRiskData(realtimeData);
        setBackendConnected(true);
        setApiError("");
        setLastFetched(new Date());

        // Fetch history
        if (historyResponse.ok) {

          const historyData = await historyResponse.json();

          setTrendData(
            Array.isArray(historyData) ? historyData : []
          );

        } else {

          setTrendData([]);

          console.error(
            "History API error:",
            historyResponse.status
          );
        }

      } catch (error) {

        console.error("Dashboard API error:", error);

        setBackendConnected(false);
        setApiError(
          error.message || "Backend connection failed."
        );

      } finally {

        setLoading(false);
      }

    },
    [selectedLocation.lat, selectedLocation.lon]
  );


  // =====================================================
  // SEARCH CITY USING OPEN-METEO GEOCODING
  // =====================================================

  const searchLocation = async (event) => {

    event.preventDefault();

    const cityName = location.trim();

    if (!cityName) {
      setLocationError("Please enter a city name.");
      return;
    }

    setSearchingLocation(true);
    setLocationError("");

    try {

      const url = new URL(
        "https://geocoding-api.open-meteo.com/v1/search"
      );

      url.search = new URLSearchParams({
        name: cityName,
        count: "10",
        language: "en",
        format: "json",
      }).toString();

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error("Unable to search for this city.");
      }

      const data = await response.json();

      if (!data.results || data.results.length === 0) {
        throw new Error(
          `No city found for "${cityName}". Try another name.`
        );
      }

      // Prefer an Indian result if multiple cities have the same name.
      const indianResult = data.results.find(
        (item) => item.country_code === "IN"
      );

      const city = indianResult || data.results[0];

      const newLocation = {
        name: [city.name, city.admin1, city.country]
          .filter(Boolean)
          .filter((value, index, array) => array.indexOf(value) === index)
          .join(", "),

        lat: Number(city.latitude),
        lon: Number(city.longitude),
      };

      if (
        !Number.isFinite(newLocation.lat) ||
        !Number.isFinite(newLocation.lon)
      ) {
        throw new Error("Invalid coordinates received for this city.");
      }

      // Update selected location.
      // The data-fetch effect will automatically call FastAPI.
      setSelectedLocation(newLocation);
      setLocation(newLocation.name);

    } catch (error) {

      console.error("Location search error:", error);

      setLocationError(
        error.message || "Unable to find this location."
      );

    } finally {

      setSearchingLocation(false);
    }
  };


  // =====================================================
  // INITIAL FETCH AND AUTOMATIC REFRESH
  // =====================================================

  useEffect(() => {

    fetchDashboardData(true);

    const interval = setInterval(() => {
      fetchDashboardData(false);
    }, 60000);

    return () => clearInterval(interval);

  }, [fetchDashboardData]);


  // =====================================================
  // FETCH RADAR SETTINGS
  // =====================================================

  const fetchRadarSettings = useCallback(async () => {

    setRadarLoading(true);

    try {

      const response = await fetch(
        `${API_BASE_URL}/api/settings`
      );

      if (!response.ok) {
        throw new Error("Unable to fetch radar settings.");
      }

      const data = await response.json();

      setIsRadarOn(data.radar_sync_enabled === true);

    } catch (error) {

      console.error("Radar settings error:", error);

    } finally {

      setRadarLoading(false);
    }

  }, []);


  useEffect(() => {

    fetchRadarSettings();

  }, [fetchRadarSettings]);


  // =====================================================
  // TOGGLE RADAR THROUGH FASTAPI
  // =====================================================

  const toggleRadar = async () => {

    if (radarUpdating || radarLoading) return;

    setRadarUpdating(true);
    setApiError("");

    try {

      const response = await fetch(
        `${API_BASE_URL}/api/settings/radar/toggle`,
        {
          method: "POST",
        }
      );

      if (!response.ok) {
        throw new Error(
          `Radar toggle failed: ${response.status}`
        );
      }

      const data = await response.json();

      if (typeof data.radar_sync_enabled !== "boolean") {
        throw new Error("Invalid radar settings response.");
      }

      setIsRadarOn(data.radar_sync_enabled);

    } catch (error) {

      console.error("Radar toggle error:", error);

      setApiError(error.message);

    } finally {

      setRadarUpdating(false);
    }
  };


  // =====================================================
  // SIDEBAR ITEMS
  // =====================================================

  const menuItems = [
    { name: "Dashboard", icon: LayoutDashboard },
    { name: "Weather Map", icon: MapPin },
    { name: "Alerts", icon: Bell },
    { name: "Data Sources", icon: Database },
    { name: "Settings", icon: Settings },
  ];


  // =====================================================
  // CURRENT LOCATION DATA
  // =====================================================

  const currentLocation = {
    name: selectedLocation.name,
    lat: riskData?.latitude ?? selectedLocation.lat,
    lon: riskData?.longitude ?? selectedLocation.lon,
  };


  // =====================================================
  // PAGE RENDERING
  // =====================================================

  const renderPage = () => {

    switch (activePage) {

      case "Dashboard":

        return (
          <DashboardView
            riskData={riskData}
            trendData={trendData}
            location={currentLocation}
            isLightMode={isLightMode}
            isRadarOn={isRadarOn}
          />
        );


      case "Weather Map":

        return (
          <div className="w-full h-full">

            <h2 className="text-xl font-bold mb-4">
              Weather Risk Map
            </h2>

            <MapComponent
              riskData={riskData}
              isLightMode={isLightMode}
              isRadarOn={isRadarOn}
            />

          </div>
        );


      case "Alerts":

        return (
          <AlertsView
            riskData={riskData}
            location={currentLocation}
            isLightMode={isLightMode}
          />
        );


      case "Data Sources":

        return (
          <DataSourcesView
            isLightMode={isLightMode}
          />
        );


      case "Settings":

        return (
          <SettingsView
            isLightMode={isLightMode}
            setIsLightMode={setIsLightMode}
            isRadarOn={isRadarOn}
            toggleRadar={toggleRadar}
          />
        );


      default:
        return null;
    }
  };


  // =====================================================
  // MAIN UI
  // =====================================================

  return (

    <div
      className={`app-shell min-h-screen flex ${
        isLightMode
          ? "bg-slate-100 text-slate-900"
          : "bg-[#0b1120] text-white"
      }`}
    >

      {/* MOBILE MENU */}

      <button
        className="mobile-menu-button"
        onClick={() => setSidebarOpen((previous) => !previous)}
        aria-label="Toggle sidebar"
      >
        {sidebarOpen ? <X /> : <Menu />}
      </button>


      {/* SIDEBAR */}

      <aside
        className={`app-sidebar ${
          sidebarOpen ? "sidebar-open" : ""
        } ${
          isLightMode
            ? "bg-white border-slate-200"
            : "bg-[#111827] border-slate-800"
        }`}
      >

        <div className="p-6">

          <h2 className="text-2xl font-black tracking-wider text-indigo-500">
            ⚡ NOWCAST
          </h2>

          <p className="text-xs text-slate-500 mt-1">
            Weather Intelligence
          </p>

        </div>


        <nav className="px-4 space-y-2">

          {menuItems.map((item) => {

            const Icon = item.icon;

            return (

              <button
                key={item.name}
                onClick={() => {
                  setActivePage(item.name);
                  setSidebarOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold transition-colors ${
                  activePage === item.name
                    ? "bg-indigo-600 text-white"
                    : isLightMode
                    ? "text-slate-600 hover:bg-slate-100"
                    : "text-slate-400 hover:bg-slate-800"
                }`}
              >

                <Icon size={19} />

                {item.name}

              </button>

            );
          })}

        </nav>


        <div className="mt-auto p-6 text-xs text-slate-500">
          AI-Powered Weather Monitoring
        </div>

      </aside>


      {/* MAIN CONTENT */}

      <main className="app-main flex-1 min-w-0 p-6 md:p-8">


        {/* HEADER */}

        <header className="flex flex-wrap justify-between items-center gap-4 mb-6">

          <div>

            <h1 className="text-2xl font-black">
              {activePage}
            </h1>

            <p className="text-sm text-slate-500 mt-1">
              AI-driven thunderstorm and lightning monitoring
            </p>

          </div>


          <div className="flex flex-wrap items-center gap-3">

            {/* BACKEND STATUS */}

            <div
              className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg border ${
                backendConnected
                  ? "text-emerald-500 border-emerald-800"
                  : "text-red-400 border-red-800"
              }`}
            >

              {backendConnected ? (
                <Wifi size={15} />
              ) : (
                <WifiOff size={15} />
              )}

              {backendConnected
                ? "Backend Connected"
                : "Backend Disconnected"}

            </div>


            {/* REFRESH BUTTON */}

            <button
              onClick={() => fetchDashboardData(true)}
              disabled={loading}
              title="Refresh weather data"
              className="p-2 rounded-lg border border-slate-700 hover:bg-slate-800 disabled:opacity-50"
            >

              <RefreshCw
                size={17}
                className={loading ? "animate-spin" : ""}
              />

            </button>


            {/* LOCATION SEARCH */}

            <form
              onSubmit={searchLocation}
              className="flex items-center gap-2 bg-slate-800/50 border border-slate-700 rounded-lg px-3 py-2"
            >

              <MapPin
                size={18}
                className="text-indigo-400 shrink-0"
              />

              <input
                value={location}
                onChange={(event) => {
                  setLocation(event.target.value);
                  setLocationError("");
                }}
                placeholder="Enter city"
                className="bg-transparent outline-none w-36 text-sm text-current"
              />

              <button
                type="submit"
                disabled={searchingLocation}
                title="Search city"
                className="text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
              >

                <Search
                  size={18}
                  className={searchingLocation ? "animate-pulse" : ""}
                />

              </button>

            </form>

          </div>

        </header>


        {/* LOCATION ERROR */}

        {locationError && (

          <div className="mb-4 p-3 rounded-lg border border-red-800 bg-red-900/20 text-red-400 text-sm">
            {locationError}
          </div>

        )}


        {/* SELECTED COORDINATES */}

        <p className="text-xs text-slate-500 mb-4">
          Selected location: {selectedLocation.name}
          {" · "}
          {selectedLocation.lat.toFixed(4)}, {selectedLocation.lon.toFixed(4)}
        </p>


        {/* LAST API UPDATE */}

        {lastFetched && (

          <p className="text-xs text-slate-500 mb-4">

            Last API update:{" "}
            {lastFetched.toLocaleTimeString("en-IN")}

            {" · "}
            Auto-refresh every 60 seconds

          </p>

        )}


        {/* API ERROR */}

        {apiError && (

          <div className="mb-5 p-4 rounded-lg border border-red-800 bg-red-900/20 text-red-400 text-sm">

            <strong>API error:</strong> {apiError}

            <p className="text-xs mt-1">
              Check that FastAPI is running at {API_BASE_URL}.
            </p>

          </div>

        )}


        {/* LOADING */}

        {loading && !riskData && (

          <div className="flex flex-col items-center justify-center py-20 text-slate-400">

            <RefreshCw
              size={30}
              className="animate-spin mb-4 text-indigo-500"
            />

            <p>Loading weather predictions...</p>

          </div>

        )}


        {/* PAGE CONTENT */}

        <div className="page-content">

          {riskData && renderPage()}


          {!loading && !riskData && (

            <div className="text-center py-16">

              <WifiOff
                size={40}
                className="mx-auto mb-4 text-red-400"
              />

              <h2 className="text-lg font-bold mb-2">
                Unable to load weather data
              </h2>

              <p className="text-sm text-slate-400 mb-4">
                Check your backend connection and try again.
              </p>

              <button
                onClick={() => fetchDashboardData(true)}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-lg"
              >
                Try Again
              </button>

            </div>

          )}

        </div>

      </main>

    </div>

  );

}

export default App;
