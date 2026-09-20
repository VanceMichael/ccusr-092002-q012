
// 基础数据登记：路段、监测设备、补给站库存（巡护/调度角色维护）
const { WIND_LIMIT_MPS, MOISTURE_MIN_PCT } = require("./thresholds");

function upsertSegment(database, input) {
  const { ref, name, windThreshold, moistureThreshold, supplyStationRef } = input;
  if (typeof ref !== "string" || !ref) return { ok: false, status: 400, error: "missing_ref" };
  if (typeof name !== "string" || !name) return { ok: false, status: 400, error: "missing_name" };
  if (supplyStationRef !== undefined && supplyStationRef !== null) {
    const station = database.prepare("SELECT ref FROM supply_stations WHERE ref = ?").get(supplyStationRef);
    if (!station) return { ok: false, status: 404, error: "supply_station_not_found" };
  }
  database
    .prepare(
      `INSERT INTO segments (ref, name, wind_threshold_mps, moisture_threshold_pct, supply_station_ref)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET
         name = excluded.name,
         wind_threshold_mps = excluded.wind_threshold_mps,
         moisture_threshold_pct = excluded.moisture_threshold_pct,
         supply_station_ref = COALESCE(excluded.supply_station_ref, segments.supply_station_ref)`
    )
    .run(
      ref,
      name,
      windThreshold ?? WIND_LIMIT_MPS,
      moistureThreshold ?? MOISTURE_MIN_PCT,
      supplyStationRef ?? null
    );
  return { ok: true, segment: database.prepare("SELECT * FROM segments WHERE ref = ?").get(ref) };
}

function upsertDevice(database, input) {
  const { ref, metric, segmentRef, active } = input;
  if (typeof ref !== "string" || !ref) return { ok: false, status: 400, error: "missing_ref" };
  if (!["wind_speed", "soil_moisture"].includes(metric)) {
    return { ok: false, status: 400, error: "invalid_metric" };
  }
  const segment = database.prepare("SELECT ref FROM segments WHERE ref = ?").get(segmentRef);
  if (!segment) return { ok: false, status: 404, error: "segment_not_found" };
  database
    .prepare(
      `INSERT INTO devices (ref, metric, segment_ref, active)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET
         metric = excluded.metric,
         segment_ref = excluded.segment_ref,
         active = excluded.active`
    )
    .run(ref, metric, segmentRef, active === false ? 0 : 1);
  return { ok: true, device: database.prepare("SELECT * FROM devices WHERE ref = ?").get(ref) };
}

function upsertStation(database, input) {
  const { ref, name, waterLiters } = input;
  if (typeof ref !== "string" || !ref) return { ok: false, status: 400, error: "missing_ref" };
  if (typeof name !== "string" || !name) return { ok: false, status: 400, error: "missing_name" };
  if (!Number.isInteger(waterLiters) || waterLiters < 0) {
    return { ok: false, status: 400, error: "invalid_water_liters" };
  }
  database
    .prepare(
      `INSERT INTO supply_stations (ref, name, water_liters_available, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ref) DO UPDATE SET
         name = excluded.name,
         water_liters_available = excluded.water_liters_available,
         updated_at = excluded.updated_at`
    )
    .run(ref, name, waterLiters, new Date().toISOString());
  return { ok: true, station: database.prepare("SELECT * FROM supply_stations WHERE ref = ?").get(ref) };
}

module.exports = { upsertSegment, upsertDevice, upsertStation };
