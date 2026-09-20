
// 路段开放决定：结合预计队伍与补给水量；同一库存原子扣减，幂等键防重复预约

const LITERS_PER_HIKER = 2; // 每名单程穿越者预计补给水量（升）

function getStation(database, ref) {
  return database
    .prepare(
      `SELECT ref, name, water_liters_available, updated_at
         FROM supply_stations WHERE ref = ?`
    )
    .get(ref);
}

function listOpenings(database, { segmentRef, status } = {}) {
  const clauses = [];
  const params = [];
  if (segmentRef) {
    clauses.push("segment_ref = ?");
    params.push(segmentRef);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return database
    .prepare(
      `SELECT id, segment_ref, team_ref, team_name, headcount, water_reserved_liters,
              supply_station_ref, idempotency_key, status, decided_by, created_at, cancelled_at
         FROM openings ${where} ORDER BY created_at DESC, id DESC`
    )
    .all(...params);
}

function bookOpening(database, input) {
  const { segmentRef, teamRef, teamName, headcount, idempotencyKey, decidedBy, litersPerHiker } = input;

  if (typeof teamRef !== "string" || !teamRef) return { ok: false, status: 400, error: "missing_team_ref" };
  if (typeof idempotencyKey !== "string" || !idempotencyKey) {
    return { ok: false, status: 400, error: "missing_idempotency_key" };
  }
  if (typeof decidedBy !== "string" || !decidedBy) {
    return { ok: false, status: 400, error: "missing_decided_by" };
  }
  if (!Number.isInteger(headcount) || headcount <= 0) {
    return { ok: false, status: 400, error: "invalid_headcount" };
  }

  const segment = database
    .prepare("SELECT ref, name, supply_station_ref FROM segments WHERE ref = ?")
    .get(segmentRef);
  if (!segment) return { ok: false, status: 404, error: "segment_not_found" };

  // 暂停中的路段（含待人工复核与已确认）不得开放
  const openRisk = database
    .prepare(
      `SELECT id, reason, status FROM risk_assessments
        WHERE segment_ref = ? AND status IN ('open', 'confirmed')`
    )
    .get(segmentRef);
  if (openRisk) return { ok: false, status: 409, error: "segment_suspended", risk: openRisk };

  if (!segment.supply_station_ref) {
    return { ok: false, status: 409, error: "no_supply_station" };
  }
  const station = getStation(database, segment.supply_station_ref);
  if (!station) return { ok: false, status: 404, error: "supply_station_not_found" };

  const reserveLiters = headcount * (litersPerHiker ?? LITERS_PER_HIKER);

  // 幂等：同队伍同键重复提交直接返回既有预约，不重复占用库存
  const existing = database
    .prepare("SELECT * FROM openings WHERE team_ref = ? AND idempotency_key = ?")
    .get(teamRef, idempotencyKey);
  if (existing) {
    return { ok: true, duplicate: true, opening: existing, station: getStation(database, station.ref) };
  }

  const now = new Date().toISOString();
  try {
    const result = database.exec("BEGIN IMMEDIATE");
    void result;
    const updated = database
      .prepare(
        `UPDATE supply_stations
            SET water_liters_available = water_liters_available - ?, updated_at = ?
          WHERE ref = ? AND water_liters_available >= ?`
      )
      .run(reserveLiters, now, station.ref, reserveLiters);
    if (updated.changes === 0) {
      database.exec("ROLLBACK");
      return {
        ok: false,
        status: 409,
        error: "insufficient_water",
        required_liters: reserveLiters,
        station: getStation(database, station.ref)
      };
    }
    const insertResult = database
      .prepare(
        `INSERT INTO openings (
            segment_ref, team_ref, team_name, headcount, water_reserved_liters,
            supply_station_ref, idempotency_key, status, decided_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'booked', ?, ?)`
      )
      .run(
        segmentRef,
        teamRef,
        teamName ?? teamRef,
        headcount,
        reserveLiters,
        station.ref,
        idempotencyKey,
        decidedBy,
        now
      );
    database.exec("COMMIT");
    return {
      ok: true,
      opening: database.prepare("SELECT * FROM openings WHERE id = ?").get(insertResult.lastInsertRowid),
      station: getStation(database, station.ref)
    };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // 事务可能已结束
    }
    if (String(error.message).includes("UNIQUE")) {
      // 并发重复提交：幂等返回
      const existing2 = database
        .prepare("SELECT * FROM openings WHERE team_ref = ? AND idempotency_key = ?")
        .get(teamRef, idempotencyKey);
      return { ok: true, duplicate: true, opening: existing2, station: getStation(database, station.ref) };
    }
    throw error;
  }
}

function cancelOpening(database, id, { cancelledBy } = {}) {
  if (typeof cancelledBy !== "string" || !cancelledBy) {
    return { ok: false, status: 400, error: "missing_cancelled_by" };
  }
  const opening = database.prepare("SELECT * FROM openings WHERE id = ?").get(id);
  if (!opening) return { ok: false, status: 404, error: "opening_not_found" };
  if (opening.status === "cancelled") {
    return { ok: false, status: 409, error: "opening_already_cancelled", opening };
  }

  const now = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `UPDATE supply_stations
            SET water_liters_available = water_liters_available + ?, updated_at = ?
          WHERE ref = ?`
      )
      .run(opening.water_reserved_liters, now, opening.supply_station_ref);
    database
      .prepare("UPDATE openings SET status = 'cancelled', cancelled_at = ? WHERE id = ?")
      .run(now, id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return {
    ok: true,
    opening: database.prepare("SELECT * FROM openings WHERE id = ?").get(id),
    station: getStation(database, opening.supply_station_ref)
  };
}

module.exports = { bookOpening, cancelOpening, listOpenings, getStation, LITERS_PER_HIKER };
