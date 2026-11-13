
import os
import sys
import re
import sqlite3
import logging
import time
from datetime import datetime
from functools import lru_cache

import requests
import pandas as pd
import torch
import torch.nn as nn
import xgboost as xgb

from fastapi import FastAPI, HTTPException, BackgroundTasks, Query
from fastapi.middleware.cors import CORSMiddleware
from apscheduler.schedulers.asyncio import AsyncIOScheduler


# =====================================================
# CONFIGURATION
# =====================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ML_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "ml_models"))

sys.path.append(ML_DIR)

DB_FILE = os.path.join(BASE_DIR, "nowcast_history.db")

XGB_PATH = os.path.join(ML_DIR, "xgboost_multi_model.json")
CONVLSTM_PATH = os.path.join(ML_DIR, "convlstm_weights.pth")

RADAR_SYNC_ENABLED = False

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("NOWCAST")


# =====================================================
# RADAR PIPELINE IMPORTS
# =====================================================

try:
    from radar_pipeline import run_pipeline as download_new_radar_images
    from radar_tensor_prep import prepare_radar_tensors

    RADAR_SCRIPTS_AVAILABLE = True

except ImportError as error:
    logger.warning("Radar scripts unavailable: %s", error)
    RADAR_SCRIPTS_AVAILABLE = False


# =====================================================
# DATABASE
# =====================================================

def init_db():
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME,
                lat REAL,
                lon REAL,
                thunder_prob REAL,
                lightning_prob REAL
            )
        """)


def save_to_history(lat, lon, thunder_prob, lightning_prob):
    with sqlite3.connect(DB_FILE) as conn:
        conn.execute("""
            INSERT INTO history
            (timestamp, lat, lon, thunder_prob, lightning_prob)
            VALUES (?, ?, ?, ?, ?)
        """, (
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            lat,
            lon,
            thunder_prob,
            lightning_prob
        ))


init_db()


# =====================================================
# CONVLSTM MODEL
# =====================================================

class ConvLSTMCell(nn.Module):

    def __init__(self, input_dim, hidden_dim, kernel_size, bias):
        super().__init__()

        self.input_dim = input_dim
        self.hidden_dim = hidden_dim
        self.kernel_size = kernel_size

        self.padding = (
            kernel_size[0] // 2,
            kernel_size[1] // 2
        )

        self.conv = nn.Conv2d(
            in_channels=input_dim + hidden_dim,
            out_channels=4 * hidden_dim,
            kernel_size=kernel_size,
            padding=self.padding,
            bias=bias
        )

    def forward(self, input_tensor, cur_state):

        h_cur, c_cur = cur_state

        combined = torch.cat([input_tensor, h_cur], dim=1)

        combined_conv = self.conv(combined)

        cc_i, cc_f, cc_o, cc_g = torch.split(
            combined_conv,
            self.hidden_dim,
            dim=1
        )

        i = torch.sigmoid(cc_i)
        f = torch.sigmoid(cc_f)
        o = torch.sigmoid(cc_o)
        g = torch.tanh(cc_g)

        c_next = f * c_cur + i * g
        h_next = o * torch.tanh(c_next)

        return h_next, c_next

    def init_hidden(self, batch_size, image_size):

        height, width = image_size

        device = self.conv.weight.device

        return (
            torch.zeros(batch_size, self.hidden_dim, height, width, device=device),
            torch.zeros(batch_size, self.hidden_dim, height, width, device=device)
        )


class SpatialRiskPredictor(nn.Module):

    def __init__(self):
        super().__init__()

        self.convlstm_cell = ConvLSTMCell(
            input_dim=1,
            hidden_dim=16,
            kernel_size=(3, 3),
            bias=True
        )

        self.flatten = nn.Flatten()
        self.fc1 = nn.Linear(16 * 64 * 64, 128)
        self.relu = nn.ReLU()
        self.fc2 = nn.Linear(128, 1)
        self.sigmoid = nn.Sigmoid()

    def forward(self, x):

        batch_size, seq_len, _, height, width = x.size()

        h, c = self.convlstm_cell.init_hidden(
            batch_size,
            (height, width)
        )

        for t in range(seq_len):
            h, c = self.convlstm_cell(
                x[:, t, :, :, :],
                (h, c)
            )

        out = self.flatten(h)
        out = self.fc1(out)
        out = self.relu(out)
        out = self.fc2(out)

        return self.sigmoid(out)


# =====================================================
# LOAD MODELS
# =====================================================

xgb_model = None
conv_model = None

try:
    if os.path.exists(XGB_PATH):
        xgb_model = xgb.XGBClassifier()
        xgb_model.load_model(XGB_PATH)
        logger.info("XGBoost model loaded.")
    else:
        logger.warning("XGBoost model file not found.")

except Exception as error:
    logger.exception("XGBoost loading failed: %s", error)


try:
    if os.path.exists(CONVLSTM_PATH):

        conv_model = SpatialRiskPredictor()

        state = torch.load(
            CONVLSTM_PATH,
            map_location=torch.device("cpu")
        )

        conv_model.load_state_dict(state)
        conv_model.eval()

        logger.info("ConvLSTM model loaded.")

    else:
        logger.warning("ConvLSTM weights not found.")

except Exception as error:
    conv_model = None
    logger.exception("ConvLSTM loading failed: %s", error)


# =====================================================
# FASTAPI APPLICATION
# =====================================================

app = FastAPI(
    title="Nowcasting SIH Backend",
    description="Location-aware AI thunderstorm and lightning monitoring",
    version="2.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173"
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)


# =====================================================
# WEATHER API
# =====================================================

# In-memory cache: fresh data is reused for 10 minutes.
# If Open-Meteo is temporarily unavailable, cached data can be
# returned for up to 6 hours with an explicit stale-data warning.
WEATHER_CACHE = {}
WEATHER_CACHE_TTL_SECONDS = 10 * 60
WEATHER_CACHE_MAX_STALE_SECONDS = 6 * 60 * 60


def get_weather(lat, lon):
    url = "https://api.open-meteo.com/v1/forecast"

    params = {
        "latitude": lat,
        "longitude": lon,
        "current": (
            "temperature_2m,"
            "relative_humidity_2m,"
            "surface_pressure,"
            "wind_speed_10m,"
            "wind_direction_10m,"
            "precipitation"
        ),
        "timezone": "auto"
    }

    # Round coordinates so tiny floating-point differences do not
    # create separate cache entries for the same requested place.
    cache_key = (round(float(lat), 4), round(float(lon), 4))
    now = time.time()
    cached = WEATHER_CACHE.get(cache_key)

    if cached and now - cached["saved_at"] <= WEATHER_CACHE_TTL_SECONDS:
        result = dict(cached["data"])
        result["_cache_status"] = "fresh_cache"
        return result

    last_error = None

    # Retry transient network failures and server errors.
    for attempt in range(3):
        try:
            response = requests.get(
                url,
                params=params,
                timeout=(10, 35)
            )
            response.raise_for_status()

            payload = response.json()
            current = payload.get("current")

            if not isinstance(current, dict) or not current:
                raise ValueError("Weather API response has no current weather data.")

            # Save only successfully validated responses.
            WEATHER_CACHE[cache_key] = {
                "data": dict(current),
                "saved_at": time.time()
            }

            current["_cache_status"] = "live"
            return current

        except (requests.RequestException, ValueError, TypeError) as error:
            last_error = error
            logger.warning(
                "Open-Meteo attempt %s/3 failed for (%s, %s): %s",
                attempt + 1, lat, lon, error
            )

            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))

    # If all retries fail, use the last successful reading for this
    # exact coordinate pair, but clearly mark it as stale.
    cached = WEATHER_CACHE.get(cache_key)

    if cached:
        age_seconds = time.time() - cached["saved_at"]

        if age_seconds <= WEATHER_CACHE_MAX_STALE_SECONDS:
            result = dict(cached["data"])
            result["_cache_status"] = "stale_cache"
            result["_cache_age_seconds"] = int(age_seconds)
            logger.warning(
                "Returning cached weather data for (%s, %s), age=%s seconds.",
                lat, lon, int(age_seconds)
            )
            return result

    logger.error(
        "Open-Meteo request failed and no usable cached data exists: %s",
        last_error
    )

    raise HTTPException(
        status_code=502,
        detail=(
            "Weather provider is temporarily unavailable after 3 attempts. "
            "No recent cached weather data is available for this location. "
            "Please retry in a minute."
        )
    )


# =====================================================
# WIND DIRECTION
# =====================================================

def get_wind_direction(degrees):

    directions = [
        "North", "North-East", "East", "South-East",
        "South", "South-West", "West", "North-West"
    ]

    if degrees is None:
        return "Unavailable"

    index = int((float(degrees) + 22.5) / 45) % 8

    return directions[index]


# =====================================================
# REGIONAL RADAR TENSOR
# =====================================================

def get_radar_tensor(lat, lon):

    # These are the only two locations currently
    # configured in the original radar download scheduler.

    regions = {
        "ghaziabad": (28.66, 77.43),
        "patna": (25.59, 85.13)
    }

    selected_region = None

    for name, (region_lat, region_lon) in regions.items():

        distance = (
            (lat - region_lat) ** 2 +
            (lon - region_lon) ** 2
        ) ** 0.5

        if distance <= 0.15:
            selected_region = name
            break

    if not selected_region:
        return None, None

    tensor_path = os.path.join(
        ML_DIR,
        f"radar_sequence_tensor_{selected_region}.pt"
    )

    if not os.path.exists(tensor_path):
        return None, selected_region

    try:
        tensor = torch.load(
            tensor_path,
            map_location="cpu"
        )

        if not isinstance(tensor, torch.Tensor):
            return None, selected_region

        return tensor.unsqueeze(0), selected_region

    except Exception as error:
        logger.exception("Radar tensor loading failed: %s", error)
        return None, selected_region


# =====================================================
# PREDICTION HISTORY
# =====================================================

@app.get("/api/history")
def get_history(
    lat: float = Query(12.9716, ge=-90, le=90),
    lon: float = Query(77.5946, ge=-180, le=180)
):

    with sqlite3.connect(DB_FILE) as conn:

        rows = conn.execute("""
            SELECT strftime('%H:%M', timestamp),
                   thunder_prob,
                   lightning_prob
            FROM history
            WHERE ABS(lat - ?) < 0.001
              AND ABS(lon - ?) < 0.001
            ORDER BY timestamp DESC
            LIMIT 20
        """, (lat, lon)).fetchall()

    history_data = [
        {
            "time": row[0],
            "thunder": row[1],
            "lightning": row[2]
        }
        for row in reversed(rows)
    ]

    return history_data


# =====================================================
# ROOT API
# =====================================================

@app.get("/")
def read_root():

    return {
        "status": "FastAPI Backend is running!",
        "service": "NOWCAST",
        "version": "2.0"
    }


# =====================================================
# SETTINGS API
# =====================================================

@app.get("/api/settings")
def get_settings():

    return {
        "radar_sync_enabled": RADAR_SYNC_ENABLED
    }


@app.post("/api/settings/radar/toggle")
def toggle_radar_sync(background_tasks: BackgroundTasks):

    global RADAR_SYNC_ENABLED

    RADAR_SYNC_ENABLED = not RADAR_SYNC_ENABLED

    if RADAR_SYNC_ENABLED:
        background_tasks.add_task(automated_radar_sync)

    return {
        "radar_sync_enabled": RADAR_SYNC_ENABLED
    }


# =====================================================
# RADAR BACKGROUND SYNC
# =====================================================

def automated_radar_sync():

    global RADAR_SYNC_ENABLED

    if not RADAR_SYNC_ENABLED:
        logger.info("Radar sync disabled.")
        return

    if not RADAR_SCRIPTS_AVAILABLE:
        logger.warning("Radar scripts are unavailable.")
        return

    logger.info("Starting radar synchronization.")

    try:

        regions = {
            "ghaziabad": (28.66, 77.43),
            "patna": (25.59, 85.13)
        }

        for name, (lat, lon) in regions.items():

            download_new_radar_images(
                lat=lat,
                lon=lon,
                loc_name=name
            )

            prepare_radar_tensors(loc_name=name)

        logger.info("Radar synchronization completed.")

    except Exception as error:
        logger.exception("Radar synchronization failed: %s", error)


scheduler = AsyncIOScheduler()


@app.on_event("startup")
def start_scheduler():

    scheduler.add_job(
        automated_radar_sync,
        "interval",
        minutes=15,
        id="radar_sync",
        replace_existing=True
    )

    scheduler.start()

    logger.info("Background Radar Sync Scheduler Started.")


@app.on_event("shutdown")
def stop_scheduler():

    if scheduler.running:
        scheduler.shutdown()


# =====================================================
# REALTIME LOCATION-AWARE RISK API
# =====================================================

@app.get("/api/realtime-risk")
def get_realtime_risk(
    background_tasks: BackgroundTasks,
    lat: float = Query(12.9716, ge=-90, le=90),
    lon: float = Query(77.5946, ge=-180, le=180)
):

    try:

        # 1. Fetch actual weather for selected coordinates

        current_data = get_weather(lat, lon)

        temperature = float(
            current_data.get("temperature_2m") or 0
        )

        humidity = float(
            current_data.get("relative_humidity_2m") or 0
        )

        pressure = float(
            current_data.get("surface_pressure") or 0
        )

        wind_speed = float(
            current_data.get("wind_speed_10m") or 0
        )

        wind_degrees = current_data.get("wind_direction_10m")

        rainfall = float(
            current_data.get("precipitation") or 0
        )

        wind_direction = get_wind_direction(wind_degrees)

        # 2. XGBoost prediction

        if xgb_model is None:
            raise HTTPException(
                status_code=503,
                detail="XGBoost model is not available."
            )

        input_features = pd.DataFrame({
            "temperature": [temperature],
            "humidity": [humidity],
            "pressure": [pressure],
            "latitude": [lat],
            "longitude": [lon]
        })

        xgb_prob = float(
            xgb_model.predict_proba(input_features)[0][1]
        )

        # 3. ConvLSTM prediction only when a matching
        # regional radar tensor is available.

        radar_tensor, radar_region = get_radar_tensor(lat, lon)

        convlstm_prob = None

        if conv_model is not None and radar_tensor is not None:

            try:
                with torch.no_grad():

                    convlstm_prob = float(
                        conv_model(radar_tensor).item()
                    )

            except Exception as error:
                logger.exception("ConvLSTM prediction failed: %s", error)

        # 4. Fusion
        # Do not treat a missing ConvLSTM prediction as zero risk.

        if convlstm_prob is not None:

            fused_probability = (
                xgb_prob * 0.6 +
                convlstm_prob * 0.4
            )

            prediction_mode = "XGBoost + ConvLSTM"

        else:

            fused_probability = xgb_prob

            prediction_mode = "XGBoost only"

        risk_percentage = round(
            fused_probability * 100,
            2
        )

        lightning_prob = round(
            risk_percentage * 0.85,
            2
        )

        if convlstm_prob is not None:

            confidence = round(
                100 - abs(xgb_prob - convlstm_prob) * 100,
                1
            )

        else:

            confidence = None

        # 5. Risk classification

        if risk_percentage > 75:
            risk_level = "Severe"

        elif risk_percentage > 50:
            risk_level = "High"

        elif risk_percentage > 25:
            risk_level = "Moderate"

        else:
            risk_level = "Low"

        # 6. Store prediction

        background_tasks.add_task(
            save_to_history,
            lat,
            lon,
            risk_percentage,
            lightning_prob
        )

        # 7. Create map zones around selected location

        map_zones = [
            {
                "lat": lat,
                "lng": lon,
                "radius": 3000,
                "level": risk_level
            },
            {
                "lat": lat + 0.02,
                "lng": lon + 0.02,
                "radius": 4500,
                "level": (
                    "Moderate"
                    if risk_percentage > 25
                    else "Low"
                )
            },
            {
                "lat": lat - 0.015,
                "lng": lon - 0.03,
                "radius": 6000,
                "level": "Low"
            }
        ]

        # 8. Return dashboard response

        return {

            "latitude": lat,
            "longitude": lon,

            "current_weather": {

                "temperature_celsius": temperature,
                "humidity_percent": humidity,
                "pressure_hpa": pressure,
                "wind_speed_kmh": wind_speed,
                "wind_direction": wind_direction,
                "rainfall_mm": rainfall
            },

            "prediction_details": {

                "thunderstorm_probability": risk_percentage,
                "lightning_probability": lightning_prob,
                "risk_level": risk_level,
                "confidence_percent": confidence,
                "forecast_window": "Next 30-60 Minutes",
                "last_updated": datetime.now().astimezone().isoformat()
            },

            "storm_movement": {

                "direction": wind_direction,
                "speed_kmh": wind_speed
            },

            "ai_status": {

                "xgboost": f"Active (Risk: {round(xgb_prob * 100, 1)}%)",

                "convlstm": (
                    f"Active (Risk: {round(convlstm_prob * 100, 1)}%)"
                    if convlstm_prob is not None
                    else "Unavailable for selected location"
                ),

                "data_sources": "Open-Meteo Weather API",

                "last_prediction": prediction_mode,

                "prediction_mode": prediction_mode,

                "radar_region": radar_region
            },

            "map_zones": map_zones
        }

    except HTTPException:
        raise

    except Exception as error:

        logger.exception("Prediction failed.")

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )
