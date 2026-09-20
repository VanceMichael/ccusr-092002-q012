
const http = require("node:http");
const path = require("node:path");
const { createDatabase } = require("./db");
const { sendJson, readJson } = require("./http-util");
const { loadTokens, requireRole } = require("./auth");
const { ingestObservations } = require("./domain/observations");
const { getAssessment, listAssessments, reviewAssessment } = require("./domain/risk");
const { bookOpening, cancelOpening, listOpenings } = require("./domain/openings");
const { upsertSegment, upsertDevice, upsertStation } = require("./domain/admin");
const { segmentSummary } = require("./domain/eco");

function createServer(options = {}) {
  const database =
    options.database ||
    createDatabase(options.databasePath || process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.sqlite3"));
  const tokens = options.tokens || loadTokens();

  const server = http.createServer(async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      const status = error.status || 500;
      sendJson(response, status, {
        error: status === 500 ? "internal_error" : error.message,
        ...(status === 500 ? {} : { detail: error.message })
      });
      if (status === 500) console.error(error);
    }
  });

  async function route(request, response) {
    const url = new URL(request.url, "http://localhost");
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    // 生态调查：仅可取得脱敏分段汇总
    if (request.method === "GET" && pathname === "/v1/eco/segment-summary") {
      const auth = requireRole(tokens, request.headers.authorization, ["eco"]);
      if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });
      const summary = segmentSummary(database, {
        from: url.searchParams.get("from") || undefined,
        to: url.searchParams.get("to") || undefined
      });
      sendJson(response, 200, { segments: summary });
      return;
    }

    // 观测接入：设备网关或巡护
    if (request.method === "POST" && pathname === "/v1/observations") {
      const auth = requireRole(tokens, request.headers.authorization, ["ingest", "ranger"]);
      if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });
      const body = await readJson(request);
      const result = ingestObservations(database, body);
      const status = result.rejected.length > 0 && result.accepted_count === 0 ? 422 : 202;
      sendJson(response, status, result);
      return;
    }

    // 风险评估查询与人工复核（巡护）
    if (request.method === "GET" && pathname === "/v1/risk-assessments") {
      const auth = requireRole(tokens, request.headers.authorization, ["ranger"]);
      if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });
      sendJson(response, 200, {
        assessments: listAssessments(database, {
          status: url.searchParams.get("status") || undefined,
          segmentRef: url.searchParams.get("segment_ref") || undefined
        })
      });
      return;
    }

    let match = pathname.match(/^\/v1\/risk-assessments\/(\d+)$/);
    if (request.method === "GET" && match) {
      const auth = requireRole(tokens, request.headers.authorization, ["ranger"]);
      if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });
      const assessment = getAssessment(database, Number(match[1]));
      if (!assessment) return sendJson(response, 404, { error: "assessment_not_found" });
      sendJson(response, 200, { assessment });
      return;
    }

    match = pathname.match(/^\/v1\/risk-assessments\/(\d+)\/reviews$/);
    if (request.method === "POST" && match) {
      const auth = requireRole(tokens, request.headers.authorization, ["ranger"]);
      if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });
      const body = await readJson(request);
      const result = reviewAssessment(database, Number(match[1]), {
        action: body.action,
        reviewerRef: body.reviewer_ref,
        note: body.note
      });
      if (!result.ok) return sendJson(response, result.status, { error: result.error });
      sendJson(response, 200, { assessment: result.assessment, reviewed_at: result.reviewed_at });
      return;
    }

    // 路段开放决定与补给预约（巡护）
    if (request.method === "GET" && pathname === "/v1/openings") {
      const auth = requireRole(tokens, request.headers.authorization, ["ranger"]);
      if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });
      sendJson(response, 200, {
        openings: listOpenings(database, {
          segmentRef: url.searchParams.get("segment_ref") || undefined,
          status: url.searchParams.get("status") || undefined
        })
      });
      return;
    }

    if (request.method === "POST" && pathname === "/v1/openings") {
      const auth = requireRole(tokens, request.headers.authorization, ["ranger"]);
      if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });
      const body = await readJson(request);
      const result = bookOpening(database, {
        segmentRef: body.segment_ref,
        teamRef: body.team_ref,
        teamName: body.team_name,
        headcount: body.headcount,
        idempotencyKey: body.idempotency_key,
        decidedBy: body.decided_by,
        litersPerHiker: body.liters_per_hiker
      });
      if (!result.ok) {
        return sendJson(response, result.status, {
          error: result.error,
          ...(result.risk ? { risk: result.risk } : {}),
          ...(result.required_liters != null ? { required_liters: result.required_liters } : {}),
          ...(result.station ? { station: result.station } : {})
        });
      }
      sendJson(response, result.duplicate ? 200 : 201, {
        opening: result.opening,
        station: result.station,
        duplicate: result.duplicate === true
      });
      return;
    }

    match = pathname.match(/^\/v1\/openings\/(\d+)\/cancel$/);
    if (request.method === "POST" && match) {
      const auth = requireRole(tokens, request.headers.authorization, ["ranger"]);
      if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });
      const body = await readJson(request).catch(() => ({}));
      const result = cancelOpening(database, Number(match[1]), {
        cancelledBy: body.cancelled_by
      });
      if (!result.ok) {
        return sendJson(response, result.status, {
          error: result.error,
          ...(result.opening ? { opening: result.opening } : {})
        });
      }
      sendJson(response, 200, { opening: result.opening, station: result.station });
      return;
    }

    // 基础数据登记（巡护）
    if (request.method === "POST" && pathname === "/v1/admin/segments") {
      const auth = requireRole(tokens, request.headers.authorization, ["ranger"]);
      if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });
      const body = await readJson(request);
      const result = upsertSegment(database, {
        ref: body.ref,
        name: body.name,
        windThreshold: body.wind_threshold_mps,
        moistureThreshold: body.moisture_threshold_pct,
        supplyStationRef: body.supply_station_ref
      });
      if (!result.ok) return sendJson(response, result.status, { error: result.error });
      sendJson(response, 200, { segment: result.segment });
      return;
    }

    if (request.method === "POST" && pathname === "/v1/admin/devices") {
      const auth = requireRole(tokens, request.headers.authorization, ["ranger"]);
      if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });
      const body = await readJson(request);
      const result = upsertDevice(database, {
        ref: body.ref,
        metric: body.metric,
        segmentRef: body.segment_ref,
        active: body.active
      });
      if (!result.ok) return sendJson(response, result.status, { error: result.error });
      sendJson(response, 200, { device: result.device });
      return;
    }

    if (request.method === "POST" && pathname === "/v1/admin/supply-stations") {
      const auth = requireRole(tokens, request.headers.authorization, ["ranger"]);
      if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });
      const body = await readJson(request);
      const result = upsertStation(database, {
        ref: body.ref,
        name: body.name,
        waterLiters: body.water_liters_available
      });
      if (!result.ok) return sendJson(response, result.status, { error: result.error });
      sendJson(response, 200, { station: result.station });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  }

  server.closeDatabase = () => database.close();
  return server;
}

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT || "8080", 10);
  createServer().listen(port, "0.0.0.0");
}

module.exports = { createServer };
