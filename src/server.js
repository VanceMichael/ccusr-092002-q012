
const http = require("node:http");
const path = require("node:path");
const { openDatabase } = require("./store");

// 路段风险阈值，可用环境变量调整
const WIND_SPEED_LIMIT = Number.parseFloat(process.env.WIND_SPEED_LIMIT || "14"); // m/s
const SOIL_MOISTURE_MIN = Number.parseFloat(process.env.SOIL_MOISTURE_MIN || "8"); // %

const ISO_OFFSET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseObservedAt(value) {
  if (typeof value !== "string" || !ISO_OFFSET_PATTERN.test(value)) {
    throw new HttpError(400, "invalid_time", "observed_at 必须是带时区偏移的 ISO 8601 字符串");
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new HttpError(400, "invalid_time", "observed_at 无法解析");
  }
  return new Date(time).toISOString();
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "invalid_json", "请求体不是合法 JSON"));
      }
    });
  });
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function requireRole(request, allowed) {
  const role = request.headers["x-role"];
  if (!role) throw new HttpError(401, "missing_role", "缺少 x-role 请求头");
  if (!allowed.includes(role)) {
    throw new HttpError(403, "forbidden", `角色 ${role} 无权访问该资源`);
  }
  return role;
}

function requireString(body, field) {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_field", `${field} 必须是非空字符串`);
  }
  return value.trim();
}

function requireNumber(body, field, { min, max } = {}) {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "invalid_field", `${field} 必须是有限数值`);
  }
  if (min !== undefined && value < min) throw new HttpError(400, "invalid_field", `${field} 不能小于 ${min}`);
  if (max !== undefined && value > max) throw new HttpError(400, "invalid_field", `${field} 不能大于 ${max}`);
  return value;
}

// ---------- 观测接入与风险判断 ----------

const VALID_QUALITIES = new Set(["valid", "suspect", "invalid"]);

function validateObservationPayload(body) {
  const sourceRef = requireString(body, "source_ref");
  const deviceRef = requireString(body, "device_ref");
  const segmentRef = requireString(body, "segment_ref");
  const observedAt = parseObservedAt(body.observed_at);
  const windSpeed = requireNumber(body, "wind_speed", { min: 0 });
  const soilMoisture = requireNumber(body, "soil_moisture", { min: 0, max: 100 });
  const quality = body.quality === undefined ? "valid" : body.quality;
  if (!VALID_QUALITIES.has(quality)) {
    throw new HttpError(400, "invalid_field", "quality 必须是 valid / suspect / invalid");
  }
  return { sourceRef, deviceRef, segmentRef, observedAt, windSpeed, soilMoisture, quality };
}

function insertObservation(db, payload) {
  const existing = db
    .prepare("SELECT * FROM observations WHERE device_ref = ? AND source_ref = ?")
    .get(payload.deviceRef, payload.sourceRef);
  if (existing) {
    const same =
      existing.segment_ref === payload.segmentRef &&
      existing.observed_at === payload.observedAt &&
      existing.wind_speed === payload.windSpeed &&
      existing.soil_moisture === payload.soilMoisture &&
      existing.quality === payload.quality;
    if (!same) {
      throw new HttpError(409, "source_conflict", "同一 source_ref 已存在内容不同的记录");
    }
    return { row: existing, deduplicated: true };
  }
  const result = db
    .prepare(
      `INSERT INTO observations
        (source_ref, device_ref, segment_ref, observed_at, received_at, wind_speed, soil_moisture, quality)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      payload.sourceRef,
      payload.deviceRef,
      payload.segmentRef,
      payload.observedAt,
      nowIso(),
      payload.windSpeed,
      payload.soilMoisture,
      payload.quality
    );
  const row = db.prepare("SELECT * FROM observations WHERE id = ?").get(result.lastInsertRowid);
  return { row, deduplicated: false };
}

function breachReasons(row) {
  const reasons = [];
  if (row.wind_speed >= WIND_SPEED_LIMIT) reasons.push("high_wind");
  if (row.soil_moisture <= SOIL_MOISTURE_MIN) reasons.push("low_soil_moisture");
  return reasons;
}

// 只有质量为 valid 的观测才参与路段风险判断
function evaluateRisk(database, row) {
  if (row.quality !== "valid") return null;
  const reasons = breachReasons(row);
  if (reasons.length === 0) return null;
  const active = database
    .prepare(
      "SELECT id FROM risk_events WHERE segment_ref = ? AND status IN ('open', 'confirmed') LIMIT 1"
    )
    .get(row.segment_ref);
  if (active) return null; // 已有未解除的暂停，不重复生成
  const result = database
    .prepare(
      "INSERT INTO risk_events (segment_ref, observation_id, reason, status, created_at) VALUES (?, ?, ?, 'open', ?)"
    )
    .run(row.segment_ref, row.id, reasons.join("+"), nowIso());
  return database.prepare("SELECT * FROM risk_events WHERE id = ?").get(result.lastInsertRowid);
}

function observationView(row) {
  return {
    id: row.id,
    source_ref: row.source_ref,
    device_ref: row.device_ref,
    segment_ref: row.segment_ref,
    observed_at: row.observed_at,
    received_at: row.received_at,
    wind_speed: row.wind_speed,
    soil_moisture: row.soil_moisture,
    quality: row.quality,
  };
}

// ---------- 补给库存 ----------

function stationWaterView(database, stationRef) {
  const station = database
    .prepare("SELECT * FROM supply_stations WHERE station_ref = ?")
    .get(stationRef);
  if (!station) throw new HttpError(404, "station_not_found", "补给站不存在");
  const reserved = database
    .prepare(
      "SELECT COALESCE(SUM(water_liters), 0) AS liters FROM reservations WHERE station_ref = ? AND status = 'booked'"
    )
    .get(stationRef).liters;
  return {
    station_ref: station.station_ref,
    segment_ref: station.segment_ref,
    water_capacity_liters: station.water_capacity_liters,
    water_reserved_liters: reserved,
    water_remaining_liters: station.water_capacity_liters - reserved,
  };
}

function reservationView(row) {
  return {
    request_ref: row.request_ref,
    station_ref: row.station_ref,
    team_ref: row.team_ref,
    team_size: row.team_size,
    water_liters: row.water_liters,
    status: row.status,
    created_at: row.created_at,
  };
}

// ---------- 路由 ----------

async function route(request, response, database, url) {
  const { pathname } = url;
  const method = request.method;

  if (method === "GET" && pathname === "/health") {
    return sendJson(response, 200, { status: "ok" });
  }

  // 观测上报：单条或批量
  if (method === "POST" && pathname === "/observations") {
    requireRole(request, ["sensor", "ranger"]);
    const body = await readJsonBody(request);
    const items = Array.isArray(body) ? body : [body];
    if (items.length === 0) throw new HttpError(400, "empty_batch", "上报内容为空");
    const results = [];
    const riskEvents = [];
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const item of items) {
        const payload = validateObservationPayload(item);
        const { row, deduplicated } = insertObservation(database, payload);
        results.push({ ...observationView(row), deduplicated });
        if (!deduplicated) {
          const event = evaluateRisk(database, row);
          if (event) riskEvents.push(event);
        }
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const body_out = { accepted: results.length, observations: results, risk_events: riskEvents };
    return sendJson(response, riskEvents.length > 0 ? 201 : 200, body_out);
  }

  // 巡护查看原始观测：按观测时间还原先后（断联补报乱序到达也能复原）
  const obsMatch = pathname.match(/^\/segments\/([^/]+)\/observations$/);
  if (method === "GET" && obsMatch) {
    requireRole(request, ["ranger"]);
    const rows = database
      .prepare("SELECT * FROM observations WHERE segment_ref = ? ORDER BY observed_at ASC, id ASC")
      .all(decodeURIComponent(obsMatch[1]));
    return sendJson(response, 200, { observations: rows.map(observationView) });
  }

  // 巡护查看风险事件：含触发暂停的原始观测与人工复核记录
  const riskMatch = pathname.match(/^\/segments\/([^/]+)\/risk-events$/);
  if (method === "GET" && riskMatch) {
    requireRole(request, ["ranger"]);
    const segmentRef = decodeURIComponent(riskMatch[1]);
    const events = database
      .prepare("SELECT * FROM risk_events WHERE segment_ref = ? ORDER BY id ASC")
      .all(segmentRef);
    const view = events.map((event) => {
      const observation = database
        .prepare("SELECT * FROM observations WHERE id = ?")
        .get(event.observation_id);
      const reviews = database
        .prepare("SELECT * FROM reviews WHERE risk_event_id = ? ORDER BY id ASC")
        .all(event.id);
      return {
        id: event.id,
        segment_ref: event.segment_ref,
        reason: event.reason,
        status: event.status,
        created_at: event.created_at,
        triggering_observation: observation ? observationView(observation) : null,
        reviews: reviews.map((review) => ({
          reviewer_ref: review.reviewer_ref,
          decision: review.decision,
          note: review.note,
          created_at: review.created_at,
        })),
      };
    });
    return sendJson(response, 200, { risk_events: view });
  }

  // 人工复核：确认暂停或解除
  const reviewMatch = pathname.match(/^\/risk-events\/(\d+)\/reviews$/);
  if (method === "POST" && reviewMatch) {
    requireRole(request, ["ranger"]);
    const body = await readJsonBody(request);
    const eventId = Number.parseInt(reviewMatch[1], 10);
    const event = database.prepare("SELECT * FROM risk_events WHERE id = ?").get(eventId);
    if (!event) throw new HttpError(404, "risk_event_not_found", "风险事件不存在");
    const reviewerRef = requireString(body, "reviewer_ref");
    const decision = body.decision;
    if (!["confirm_pause", "release"].includes(decision)) {
      throw new HttpError(400, "invalid_field", "decision 必须是 confirm_pause 或 release");
    }
    if (event.status === "released") {
      throw new HttpError(409, "already_released", "该事件已解除，不能再次复核");
    }
    const note = typeof body.note === "string" ? body.note : null;
    database.exec("BEGIN IMMEDIATE");
    try {
      database
        .prepare(
          "INSERT INTO reviews (risk_event_id, reviewer_ref, decision, note, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(eventId, reviewerRef, decision, note, nowIso());
      database
        .prepare("UPDATE risk_events SET status = ? WHERE id = ?")
        .run(decision === "release" ? "released" : "confirmed", eventId);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const updated = database.prepare("SELECT * FROM risk_events WHERE id = ?").get(eventId);
    return sendJson(response, 200, { risk_event: updated });
  }

  // 登记补给站
  if (method === "POST" && pathname === "/stations") {
    requireRole(request, ["ranger"]);
    const body = await readJsonBody(request);
    const stationRef = requireString(body, "station_ref");
    const segmentRef = requireString(body, "segment_ref");
    const capacity = requireNumber(body, "water_capacity_liters", { min: 0 });
    const existing = database
      .prepare("SELECT station_ref FROM supply_stations WHERE station_ref = ?")
      .get(stationRef);
    if (existing) throw new HttpError(409, "station_exists", "补给站已存在");
    database
      .prepare(
        "INSERT INTO supply_stations (station_ref, segment_ref, water_capacity_liters) VALUES (?, ?, ?)"
      )
      .run(stationRef, segmentRef, capacity);
    return sendJson(response, 201, stationWaterView(database, stationRef));
  }

  // 查看补给站库存
  const stationMatch = pathname.match(/^\/stations\/([^/]+)$/);
  if (method === "GET" && stationMatch) {
    requireRole(request, ["ranger", "supply"]);
    return sendJson(response, 200, stationWaterView(database, decodeURIComponent(stationMatch[1])));
  }

  // 预约补给：request_ref 幂等，事务内校验剩余水量，避免重复占用
  if (method === "POST" && pathname === "/reservations") {
    requireRole(request, ["supply", "ranger"]);
    const body = await readJsonBody(request);
    const requestRef = requireString(body, "request_ref");
    const stationRef = requireString(body, "station_ref");
    const teamRef = requireString(body, "team_ref");
    const teamSize = requireNumber(body, "team_size", { min: 1 });
    if (!Number.isInteger(teamSize)) throw new HttpError(400, "invalid_field", "team_size 必须是整数");
    const waterLiters = requireNumber(body, "water_liters", { min: 0.000001 });

    const existing = database
      .prepare("SELECT * FROM reservations WHERE request_ref = ?")
      .get(requestRef);
    if (existing) {
      const same =
        existing.station_ref === stationRef &&
        existing.team_ref === teamRef &&
        existing.team_size === teamSize &&
        existing.water_liters === waterLiters;
      if (!same) throw new HttpError(409, "request_conflict", "同一 request_ref 已存在内容不同的预约");
      return sendJson(response, 200, { ...reservationView(existing), deduplicated: true });
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      const station = stationWaterView(database, stationRef);
      if (waterLiters > station.water_remaining_liters) {
        throw new HttpError(409, "insufficient_water", "剩余水量不足，预约被拒绝");
      }
      database
        .prepare(
          `INSERT INTO reservations
            (request_ref, station_ref, team_ref, team_size, water_liters, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'booked', ?)`
        )
        .run(requestRef, stationRef, teamRef, teamSize, waterLiters, nowIso());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    const row = database.prepare("SELECT * FROM reservations WHERE request_ref = ?").get(requestRef);
    return sendJson(response, 201, { ...reservationView(row), deduplicated: false });
  }

  // 取消预约，释放库存
  const cancelMatch = pathname.match(/^\/reservations\/([^/]+)\/cancel$/);
  if (method === "POST" && cancelMatch) {
    requireRole(request, ["supply", "ranger"]);
    const requestRef = decodeURIComponent(cancelMatch[1]);
    const row = database.prepare("SELECT * FROM reservations WHERE request_ref = ?").get(requestRef);
    if (!row) throw new HttpError(404, "reservation_not_found", "预约不存在");
    if (row.status === "cancelled") {
      return sendJson(response, 200, reservationView(row));
    }
    database.prepare("UPDATE reservations SET status = 'cancelled' WHERE request_ref = ?").run(requestRef);
    const updated = database.prepare("SELECT * FROM reservations WHERE request_ref = ?").get(requestRef);
    return sendJson(response, 200, reservationView(updated));
  }

  // 开放决定：结合路段风险状态、预计队伍与所需水量
  const openingMatch = pathname.match(/^\/segments\/([^/]+)\/opening-checks$/);
  if (method === "POST" && openingMatch) {
    requireRole(request, ["supply", "ranger"]);
    const segmentRef = decodeURIComponent(openingMatch[1]);
    const body = await readJsonBody(request);
    const teamSize = requireNumber(body, "team_size", { min: 1 });
    const waterLiters = requireNumber(body, "water_liters", { min: 0 });
    const reasons = [];
    const activeEvent = database
      .prepare(
        "SELECT id, reason, status FROM risk_events WHERE segment_ref = ? AND status IN ('open', 'confirmed') ORDER BY id DESC LIMIT 1"
      )
      .get(segmentRef);
    if (activeEvent) reasons.push({ code: "segment_paused", risk_event_id: activeEvent.id, reason: activeEvent.reason });
    const stations = database
      .prepare("SELECT station_ref FROM supply_stations WHERE segment_ref = ?")
      .all(segmentRef);
    const remaining = stations.reduce(
      (total, station) => total + stationWaterView(database, station.station_ref).water_remaining_liters,
      0
    );
    if (waterLiters > remaining) {
      reasons.push({ code: "insufficient_water", water_remaining_liters: remaining });
    }
    return sendJson(response, 200, {
      segment_ref: segmentRef,
      team_size: teamSize,
      water_liters: waterLiters,
      water_remaining_liters: remaining,
      decision: reasons.length === 0 ? "open" : "hold",
      reasons,
    });
  }

  // 生态调查：脱敏的分段汇总（按日聚合，不含设备编号与精确时刻）
  const summaryMatch = pathname.match(/^\/segments\/([^/]+)\/summary$/);
  if (method === "GET" && summaryMatch) {
    requireRole(request, ["researcher", "ranger"]);
    const segmentRef = decodeURIComponent(summaryMatch[1]);
    const rows = database
      .prepare(
        `SELECT substr(observed_at, 1, 10) AS day,
                COUNT(*) AS observation_count,
                ROUND(AVG(wind_speed), 2) AS avg_wind_speed,
                ROUND(MAX(wind_speed), 2) AS max_wind_speed,
                ROUND(AVG(soil_moisture), 2) AS avg_soil_moisture,
                ROUND(MIN(soil_moisture), 2) AS min_soil_moisture
         FROM observations
         WHERE segment_ref = ? AND quality = 'valid'
         GROUP BY day
         ORDER BY day ASC`
      )
      .all(segmentRef);
    return sendJson(response, 200, { segment_ref: segmentRef, daily: rows });
  }

  throw new HttpError(404, "not_found", "接口不存在");
}

function createServer(options = {}) {
  const databasePath =
    options.databasePath || process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3");
  const database = options.database || openDatabase(databasePath);
  return http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    route(request, response, database, url).catch((error) => {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.code, message: error.message });
      } else {
        sendJson(response, 500, { error: "internal_error" });
      }
    });
  });
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0");
}

module.exports = { createServer };
