-- 核心领域表：观测、风险事件、人工复核、补给站与预约

CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_ref TEXT NOT NULL,              -- 提交方对同一记录的识别符（断联补报去重键）
    device_ref TEXT NOT NULL,
    segment_ref TEXT NOT NULL,
    observed_at TEXT NOT NULL,             -- 观测时间，ISO 8601 带时区偏移
    received_at TEXT NOT NULL,             -- 服务端接收时间
    wind_speed REAL NOT NULL,
    soil_moisture REAL NOT NULL,
    quality TEXT NOT NULL DEFAULT 'valid'  -- valid | suspect | invalid
        CHECK (quality IN ('valid', 'suspect', 'invalid')),
    UNIQUE (device_ref, source_ref)        -- 同一设备同一来源记录只入库一次
);
CREATE INDEX IF NOT EXISTS idx_observations_segment_time
    ON observations (segment_ref, observed_at, id);

CREATE TABLE IF NOT EXISTS risk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_ref TEXT NOT NULL,
    observation_id INTEGER NOT NULL REFERENCES observations(id),
    reason TEXT NOT NULL,                  -- high_wind | low_soil_moisture | high_wind+low_soil_moisture
    status TEXT NOT NULL DEFAULT 'open'    -- open | confirmed | released
        CHECK (status IN ('open', 'confirmed', 'released')),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risk_events_segment_status
    ON risk_events (segment_ref, status);

CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    risk_event_id INTEGER NOT NULL REFERENCES risk_events(id),
    reviewer_ref TEXT NOT NULL,
    decision TEXT NOT NULL                 -- confirm_pause | release
        CHECK (decision IN ('confirm_pause', 'release')),
    note TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supply_stations (
    station_ref TEXT PRIMARY KEY,
    segment_ref TEXT NOT NULL,
    water_capacity_liters REAL NOT NULL CHECK (water_capacity_liters >= 0)
);

CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_ref TEXT NOT NULL UNIQUE,      -- 预约方幂等键，防止重复占用库存
    station_ref TEXT NOT NULL REFERENCES supply_stations(station_ref),
    team_ref TEXT NOT NULL,
    team_size INTEGER NOT NULL CHECK (team_size > 0),
    water_liters REAL NOT NULL CHECK (water_liters > 0),
    status TEXT NOT NULL DEFAULT 'booked'  -- booked | cancelled
        CHECK (status IN ('booked', 'cancelled')),
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservations_station_status
    ON reservations (station_ref, status);

INSERT OR IGNORE INTO schema_migrations(version) VALUES ('002_core');
