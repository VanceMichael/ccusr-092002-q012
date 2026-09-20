
// 观测接入：质量标记、断联补报、来源编号幂等去重、先后顺序还原、风险触发
const { withTransaction } = require("../db");
const { WIND_MAX_MPS } = require("./thresholds");

const QUALITY_FLAGS = new Set(["good", "suspect", "bad"]);

// 必须带时区偏移（Z 或 ±HH:MM），避免现场设备本地时间歧义
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function parseObservedAt(value) {
  if (typeof value !== "string" || !ISO_WITH_OFFSET.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isPlausible(metric, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  if (metric === "wind_speed") return value <= WIND_MAX_MPS;
  return value <= 100; // 体积含水率百分比
}

function normalizeBody(body) {
  return Array.isArray(body) ? body : [body];
}

// 按设备侧采样时间排序，保证断联补报也能还原现场先后
function orderByObservedAt(rows) {
  return [...rows].sort((a, b) => a.observedAtDate.getTime() - b.observedAtDate.getTime());
}

function ingestObservations(database, body, now = new Date()) {
  const rawRows = normalizeBody(body);
  const selectDevice = database.prepare(
    "SELECT ref, metric, segment_ref, active FROM devices WHERE ref = ?"
  );
  const insertObservation = database.prepare(`
    INSERT INTO observations (
      source_record_id, device_ref, segment_ref, metric, value,
      observed_at, observed_at_ms, quality_flag, is_backfill, ingested_at, valid
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_record_id, device_ref) DO NOTHING
  `);
  const latestBefore = database.prepare(`
    SELECT id, value FROM observations
    WHERE segment_ref = ? AND metric = ? AND valid = 1 AND observed_at_ms <= ?
    ORDER BY observed_at_ms DESC, id DESC LIMIT 1
  `);

  const prepared = [];
  const rejected = [];
  for (const row of rawRows) {
    const device = row && typeof row.device_ref === "string" ? selectDevice.get(row.device_ref) : null;
    const observedAtDate = row ? parseObservedAt(row.observed_at) : null;
    const qualityFlag = row?.quality_flag ?? "good";
    const failures = [];
    if (!device) failures.push("unknown_device");
    if (!observedAtDate) failures.push("invalid_observed_at");
    if (typeof row?.source_record_id !== "string" || !row.source_record_id) failures.push("missing_source_record_id");
    if (typeof row?.value !== "number" || !Number.isFinite(row.value)) failures.push("invalid_value");
    if (!QUALITY_FLAGS.has(qualityFlag)) failures.push("invalid_quality_flag");
    if (failures.length > 0) {
      rejected.push({ source_record_id: row?.source_record_id ?? null, reasons: failures });
      continue;
    }
    const valid = qualityFlag === "good" && isPlausible(device.metric, row.value);
    prepared.push({
      sourceRecordId: row.source_record_id,
      device,
      value: row.value,
      observedAt: row.observed_at,
      observedAtDate,
      qualityFlag,
      isBackfill: row.is_backfill === true ? 1 : 0,
      valid: valid ? 1 : 0
    });
  }

  const ingestedAt = now.toISOString();
  const accepted = [];
  const duplicates = [];
  const triggered = [];

  const insertOne = (item) =>
    withTransaction(database, () => {
      const result = insertObservation.run(
        item.sourceRecordId,
        item.device.ref,
        item.device.segment_ref,
        item.device.metric,
        item.value,
        item.observedAt,
        item.observedAtDate.getTime(),
        item.qualityFlag,
        item.isBackfill,
        ingestedAt,
        item.valid
      );
      if (result.changes === 0) {
        duplicates.push({ source_record_id: item.sourceRecordId, device_ref: item.device.ref });
        return;
      }
      const id = Number(result.lastInsertRowid);
      accepted.push({ id, ...item });
      if (item.valid !== 1) return;
      maybeTriggerRisk(database, { ...item, id }, { latestBefore, triggered });
    });

  for (const item of orderByObservedAt(prepared)) insertOne(item);

  return {
    received: rawRows.length,
    accepted_count: accepted.length,
    duplicate_count: duplicates.length,
    rejected,
    duplicates,
    triggered
  };
}

// 只有有效观测才能触发风险；评估的是“该观测发生时刻”路段的最新状态
function maybeTriggerRisk(database, item, { latestBefore, triggered }) {
  const { segment_ref: segmentRef, metric } = item.device;
  const segment = database
    .prepare("SELECT wind_threshold_mps, moisture_threshold_pct FROM segments WHERE ref = ?")
    .get(segmentRef);
  if (!segment) return;

  const latestWind = latestBefore.get(segmentRef, "wind_speed", item.observedAtDate.getTime());
  const latestMoisture = latestBefore.get(segmentRef, "soil_moisture", item.observedAtDate.getTime());
  const windBreach = latestWind && latestWind.value > segment.wind_threshold_mps;
  const moistureBreach = latestMoisture && latestMoisture.value < segment.moisture_threshold_pct;
  if (!windBreach && !moistureBreach) return;

  // 必须是本条新观测造成的越限；仅追踪另一要素的旧读数不重复触发
  const causedWind = metric === "wind_speed" && latestWind.id === item.id && windBreach;
  const causedMoisture = metric === "soil_moisture" && latestMoisture.id === item.id && moistureBreach;
  if (!causedWind && !causedMoisture) return;

  const openRisk = database
    .prepare("SELECT id FROM risk_assessments WHERE segment_ref = ? AND status IN ('open','confirmed')")
    .get(segmentRef);
  if (openRisk) return;

  // 该路段在更晚的采样时刻已有风险事件（含已解除），迟到补报不再重开历史风险
  const laterEvent = database
    .prepare("SELECT 1 FROM risk_assessments WHERE segment_ref = ? AND triggered_at_ms >= ? LIMIT 1")
    .get(segmentRef, item.observedAtDate.getTime());
  if (laterEvent) return;

  const reason = windBreach && moistureBreach ? "both" : windBreach ? "high_wind" : "low_moisture";
  try {
    const result = database
      .prepare(`
        INSERT INTO risk_assessments
          (segment_ref, reason, triggered_at, triggered_at_ms, triggered_by_observation_id, status)
        VALUES (?, ?, ?, ?, ?, 'open')
      `)
      .run(segmentRef, reason, item.observedAt, item.observedAtDate.getTime(), item.id);
    triggered.push({
      assessment_id: Number(result.lastInsertRowid),
      segment_ref: segmentRef,
      reason,
      triggered_at: item.observedAt,
      thresholds: {
        wind_speed_mps: segment.wind_threshold_mps,
        soil_moisture_pct: segment.moisture_threshold_pct
      },
      wind: latestWind ? latestWind.value : null,
      soil_moisture: latestMoisture ? latestMoisture.value : null
    });
  } catch (error) {
    // 并发下唯一索引兜底：同路段已有未解除风险
    if (!String(error.message).includes("UNIQUE")) throw error;
  }
}

module.exports = { ingestObservations, parseObservedAt };
