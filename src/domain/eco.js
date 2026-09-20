
// 生态调查视角：脱敏的分段汇总
// 只暴露路段与时段聚合，不含设备编号、来源记录编号、原始读数明细、人员与补给信息。

function segmentSummary(database, { from, to } = {}) {
  const clauses = ["valid = 1"];
  const params = [];
  if (from) {
    clauses.push("observed_at_ms >= ?");
    params.push(Date.parse(from));
  }
  if (to) {
    clauses.push("observed_at_ms <= ?");
    params.push(Date.parse(to));
  }
  const where = clauses.join(" AND ");

  return database
    .prepare(
      `SELECT s.ref AS segment_ref,
              s.name AS segment_name,
              COUNT(o.id) AS valid_observation_count,
              MIN(o.observed_at_ms) AS first_observed_at_ms,
              MAX(o.observed_at_ms) AS last_observed_at_ms,
              AVG(CASE WHEN o.metric = 'wind_speed' THEN o.value END) AS avg_wind_speed_mps,
              MAX(CASE WHEN o.metric = 'wind_speed' THEN o.value END) AS max_wind_speed_mps,
              AVG(CASE WHEN o.metric = 'soil_moisture' THEN o.value END) AS avg_soil_moisture_pct,
              MIN(CASE WHEN o.metric = 'soil_moisture' THEN o.value END) AS min_soil_moisture_pct,
              SUM(CASE WHEN o.is_backfill = 1 THEN 1 ELSE 0 END) AS backfill_count
         FROM segments s
         LEFT JOIN observations o ON o.segment_ref = s.ref AND ${where}
        GROUP BY s.ref
        ORDER BY s.ref`
    )
    .all(...params)
    .map((row) => ({
      segment_ref: row.segment_ref,
      segment_name: row.segment_name,
      window: { from: from ?? null, to: to ?? null },
      valid_observation_count: row.valid_observation_count,
      first_observed_at: row.first_observed_at_ms == null ? null : new Date(row.first_observed_at_ms).toISOString(),
      last_observed_at: row.last_observed_at_ms == null ? null : new Date(row.last_observed_at_ms).toISOString(),
      backfill_count: row.backfill_count,
      wind_speed_mps: roundAggregate(row.avg_wind_speed_mps, row.max_wind_speed_mps),
      soil_moisture_pct: roundAggregate(row.avg_soil_moisture_pct, row.min_soil_moisture_pct)
    }));
}

function roundAggregate(avg, extreme) {
  if (avg === null || avg === undefined) return null;
  return {
    avg: Math.round(avg * 100) / 100,
    extreme: Math.round(extreme * 100) / 100
  };
}

module.exports = { segmentSummary };
