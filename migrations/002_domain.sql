-- 领域表：传感器观测、路段风险、人工复核、补给库存与开放预约

-- 路段：路线上被巡护和开放决定管理的分段
CREATE TABLE IF NOT EXISTS segments (
    ref TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    wind_threshold_mps REAL NOT NULL DEFAULT 10.8,   -- 10.8 m/s ≈ 6 级强风上限
    moisture_threshold_pct REAL NOT NULL DEFAULT 8.0, -- 墒情低于该值视为干旱风险
    supply_station_ref TEXT
);

-- 设备：不同设备分别上报风速或墒情
CREATE TABLE IF NOT EXISTS devices (
    ref TEXT PRIMARY KEY,
    metric TEXT NOT NULL CHECK (metric IN ('wind_speed', 'soil_moisture')),
    segment_ref TEXT NOT NULL REFERENCES segments(ref),
    active INTEGER NOT NULL DEFAULT 1
);

-- 观测记录：不同设备的读数，带时间与质量标记
CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_record_id TEXT NOT NULL,            -- 提交方对同一记录的识别符
    device_ref TEXT NOT NULL REFERENCES devices(ref),
    segment_ref TEXT NOT NULL REFERENCES segments(ref),
    metric TEXT NOT NULL CHECK (metric IN ('wind_speed', 'soil_moisture')),
    value REAL NOT NULL,
    observed_at TEXT NOT NULL,                 -- 设备侧采样时间（带偏移 ISO 8601，原样留存）
    observed_at_ms INTEGER NOT NULL,           -- 采样时间归一化 epoch 毫秒，用于时序比较
    quality_flag TEXT NOT NULL CHECK (quality_flag IN ('good', 'suspect', 'bad')),
    is_backfill INTEGER NOT NULL DEFAULT 0,    -- 断联恢复后补报
    ingested_at TEXT NOT NULL,                 -- 服务端接收时间
    valid INTEGER NOT NULL DEFAULT 1,          -- quality_flag='good' 且读数合理
    UNIQUE(source_record_id, device_ref)
);

CREATE INDEX IF NOT EXISTS idx_observations_segment_time
    ON observations(segment_ref, observed_at_ms);
CREATE INDEX IF NOT EXISTS idx_observations_valid ON observations(valid) WHERE valid = 1;

-- 风险评估：有效观测越限触发的路段暂停
CREATE TABLE IF NOT EXISTS risk_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_ref TEXT NOT NULL REFERENCES segments(ref),
    reason TEXT NOT NULL CHECK (reason IN ('high_wind', 'low_moisture', 'both')),
    triggered_at TEXT NOT NULL,
    triggered_at_ms INTEGER NOT NULL,
    triggered_by_observation_id INTEGER NOT NULL REFERENCES observations(id),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'resolved')),
    resolved_at TEXT,
    reviewer_ref TEXT,                         -- 人工复核的巡护人员标识
    review_note TEXT,
    UNIQUE(triggered_by_observation_id)
);

-- 同一路段同时只保留一个未解除风险：partial unique index
CREATE UNIQUE INDEX IF NOT EXISTS ux_risk_open_per_segment
    ON risk_assessments(segment_ref) WHERE status IN ('open', 'confirmed');

-- 补给站与库存
CREATE TABLE IF NOT EXISTS supply_stations (
    ref TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    water_liters_available INTEGER NOT NULL DEFAULT 0 CHECK (water_liters_available >= 0),
    updated_at TEXT NOT NULL

);

-- 开放决定（预约）：结合预计队伍与水量，幂等防重复预约
CREATE TABLE IF NOT EXISTS openings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_ref TEXT NOT NULL REFERENCES segments(ref),
    team_ref TEXT NOT NULL,
    team_name TEXT NOT NULL,
    headcount INTEGER NOT NULL CHECK (headcount > 0),
    water_reserved_liters INTEGER NOT NULL CHECK (water_reserved_liters >= 0),
    supply_station_ref TEXT REFERENCES supply_stations(ref),
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled')),
    decided_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    cancelled_at TEXT,
    UNIQUE(team_ref, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_openings_station ON openings(supply_station_ref, status);
