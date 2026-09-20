
const assert = require("node:assert/strict");
const test = require("node:test");
const { createServer } = require("../src/server");

const TOKENS = { ingest: "gw-token", ranger: "ranger-token", eco: "eco-token" };

async function startHarness() {
  const server = createServer({ databasePath: ":memory:", tokens: TOKENS });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    stop: async () => {
      await new Promise((resolve) => server.close(resolve));
      server.closeDatabase();
    },
    request: async (method, path, body, role = "ranger", headers = {}) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...(role ? { authorization: `Bearer ${TOKENS[role]}` } : {}),
          ...headers
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const json = response.status === 204 ? null : await response.json();
      return { status: response.status, body: json };
    }
  };
}

async function seedSegment(h, { segment = "DUNE-A", station = "WELL-1", water = 40 } = {}) {
  await h.request("POST", "/v1/admin/supply-stations", {
    ref: station,
    name: `${station} 补给点`,
    water_liters_available: water
  });
  const segmentResult = await h.request("POST", "/v1/admin/segments", {
    ref: segment,
    name: `${segment} 草方格段`,
    supply_station_ref: station
  });
  assert.equal(segmentResult.status, 200);
  for (const [ref, metric] of [
    [`${segment}-W`, "wind_speed"],
    [`${segment}-M`, "soil_moisture"]
  ]) {
    const result = await h.request("POST", "/v1/admin/devices", {
      ref,
      metric,
      segment_ref: segment
    });
    assert.equal(result.status, 200);
  }
}

function observation(deviceRef, sourceRecordId, value, observedAt, extra = {}) {
  return {
    device_ref: deviceRef,
    source_record_id: sourceRecordId,
    value,
    observed_at: observedAt,
    quality_flag: "good",
    ...extra
  };
}

test("健康接口返回服务状态", async () => {
  const h = await startHarness();
  try {
    const response = await fetch(`${h.base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    await h.stop();
  }
});

test("质量标记：仅有效观测入库为有效且可触发风险", async () => {
  const h = await startHarness();
  try {
    await seedSegment(h);
    // suspect 越限读数不得触发
    let r = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "s1", 12, "2026-09-20T09:00:00+08:00", { quality_flag: "suspect" }),
      "ingest"
    );
    assert.equal(r.status, 202);
    assert.equal(r.body.triggered.length, 0);

    // 读数明显异常（999 m/s）即使标记 good 也判为无效
    r = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "s2", 999, "2026-09-20T09:05:00+08:00")
    );
    assert.equal(r.body.triggered.length, 0);

    // 正常有效越限读数触发暂停
    r = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "s3", 12, "2026-09-20T09:10:00+08:00")
    );
    assert.equal(r.body.triggered.length, 1);
    assert.equal(r.body.triggered[0].reason, "high_wind");
    assert.equal(r.body.triggered[0].triggered_at, "2026-09-20T09:10:00+08:00");

    // 已在暂停中：后续越限不重复触发
    r = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "s4", 13, "2026-09-20T09:15:00+08:00")
    );
    assert.equal(r.body.triggered.length, 0);
  } finally {
    await h.stop();
  }
});

test("断联补报：乱序到达按采样时间还原先后并触发", async () => {
  const h = await startHarness();
  try {
    await seedSegment(h);
    // 先到 10:00 的安全读数
    let r = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "late-safe", 5, "2026-09-20T10:00:00+08:00")
    );
    assert.equal(r.body.triggered.length, 0);

    // 断联恢复后补报 09:00 的越限读数
    r = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "backfill-1", 12, "2026-09-20T09:00:00+08:00", { is_backfill: true }),
      "ingest"
    );
    assert.equal(r.body.triggered.length, 1);
    assert.equal(r.body.triggered[0].triggered_at, "2026-09-20T09:00:00+08:00");
  } finally {
    await h.stop();
  }
});

test("来源编号幂等：重复上报去重且不重复触发", async () => {
  const h = await startHarness();
  try {
    await seedSegment(h);
    const payload = observation("DUNE-A-W", "dup-1", 12, "2026-09-20T09:00:00+08:00");
    let r = await h.request("POST", "/v1/observations", payload);
    assert.equal(r.body.accepted_count, 1);
    r = await h.request("POST", "/v1/observations", payload);
    assert.equal(r.status, 202);
    assert.equal(r.body.duplicate_count, 1);
    assert.equal(r.body.accepted_count, 0);

    const list = await h.request("GET", "/v1/risk-assessments");
    assert.equal(list.body.assessments.length, 1);
  } finally {
    await h.stop();
  }
});

test("非法观测被拒绝并给出原因", async () => {
  const h = await startHarness();
  try {
    await seedSegment(h);
    const r = await h.request("POST", "/v1/observations", [
      observation("UNKNOWN-DEV", "x1", 12, "2026-09-20T09:00:00+08:00"),
      observation("DUNE-A-W", "x2", 12, "2026-09-20 09:00:00"),
      { device_ref: "DUNE-A-W", value: 12, observed_at: "2026-09-20T09:00:00+08:00" }
    ]);
    assert.equal(r.status, 422);
    assert.deepEqual(r.body.rejected[0].reasons, ["unknown_device"]);
    assert.ok(r.body.rejected[1].reasons.includes("invalid_observed_at"));
    assert.ok(r.body.rejected[2].reasons.includes("missing_source_record_id"));
  } finally {
    await h.stop();
  }
});

test("巡护复核：可查看触发原始观测，确认维持与解除", async () => {
  const h = await startHarness();
  try {
    await seedSegment(h);
    const ingest = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "t1", 12, "2026-09-20T09:00:00+08:00")
    );
    const assessmentId = ingest.body.triggered[0].assessment_id;

    const detail = await h.request("GET", `/v1/risk-assessments/${assessmentId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.assessment.trigger_observation.source_record_id, "t1");
    assert.equal(detail.body.assessment.trigger_observation.value, 12);

    const confirmed = await h.request("POST", `/v1/risk-assessments/${assessmentId}/reviews`, {
      action: "confirm",
      reviewer_ref: "ranger-li",
      note: "现场阵风持续，维持暂停"
    });
    assert.equal(confirmed.body.assessment.status, "confirmed");
    assert.equal(confirmed.body.assessment.reviewer_ref, "ranger-li");

    const resolved = await h.request("POST", `/v1/risk-assessments/${assessmentId}/reviews`, {
      action: "resolve",
      reviewer_ref: "ranger-li",
      note: "风速回落，解除"
    });
    assert.equal(resolved.body.assessment.status, "resolved");
    assert.ok(resolved.body.assessment.resolved_at);

    const repeat = await h.request("POST", `/v1/risk-assessments/${assessmentId}/reviews`, {
      action: "resolve",
      reviewer_ref: "ranger-li"
    });
    assert.equal(repeat.status, 409);
  } finally {
    await h.stop();
  }
});

test("开放预约：占用水量、幂等防重复、库存不足与暂停拦截、取消归还", async () => {
  const h = await startHarness();
  try {
    await seedSegment(h, { water: 40 });

    // 5 人 × 2 升 = 10 升
    let r = await h.request("POST", "/v1/openings", {
      segment_ref: "DUNE-A",
      team_ref: "TEAM-1",
      team_name: "首批队伍",
      headcount: 5,
      idempotency_key: "open-1",
      decided_by: "ranger-li"
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.opening.water_reserved_liters, 10);
    assert.equal(r.body.station.water_liters_available, 30);

    // 同一幂等键重复提交：直接返回既有预约，库存不变
    r = await h.request("POST", "/v1/openings", {
      segment_ref: "DUNE-A",
      team_ref: "TEAM-1",
      headcount: 5,
      idempotency_key: "open-1",
      decided_by: "ranger-li"
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.duplicate, true);
    assert.equal(r.body.station.water_liters_available, 30);

    // 库存不足：需要 40 升，仅剩 30
    r = await h.request("POST", "/v1/openings", {
      segment_ref: "DUNE-A",
      team_ref: "TEAM-2",
      headcount: 20,
      idempotency_key: "open-2",
      decided_by: "ranger-li"
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "insufficient_water");
    assert.equal(r.body.required_liters, 40);
    assert.equal(r.body.station.water_liters_available, 30);

    // 触发暂停后开放被拦截
    await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "wind-block", 12, "2026-09-20T11:00:00+08:00")
    );
    r = await h.request("POST", "/v1/openings", {
      segment_ref: "DUNE-A",
      team_ref: "TEAM-3",
      headcount: 1,
      idempotency_key: "open-3",
      decided_by: "ranger-li"
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "segment_suspended");

    // 取消预约归还水量
    const openingId = (await h.request("GET", "/v1/openings?status=booked")).body.openings[0].id;
    r = await h.request("POST", `/v1/openings/${openingId}/cancel`, { cancelled_by: "ranger-li" });
    assert.equal(r.status, 200);
    assert.equal(r.body.station.water_liters_available, 40);

    r = await h.request("POST", `/v1/openings/${openingId}/cancel`, { cancelled_by: "ranger-li" });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "opening_already_cancelled");
  } finally {
    await h.stop();
  }
});

test("风险解除后路段可重新开放，再次越限可重新触发", async () => {
  const h = await startHarness();
  try {
    await seedSegment(h, { water: 100 });
    await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "w1", 12, "2026-09-20T09:00:00+08:00")
    );
    const assessmentId = (await h.request("GET", "/v1/risk-assessments?status=open")).body.assessments[0].id;
    await h.request("POST", `/v1/risk-assessments/${assessmentId}/reviews`, {
      action: "resolve",
      reviewer_ref: "ranger-li"
    });

    const opened = await h.request("POST", "/v1/openings", {
      segment_ref: "DUNE-A",
      team_ref: "TEAM-9",
      headcount: 3,
      idempotency_key: "reopen-1",
      decided_by: "ranger-li"
    });
    assert.equal(opened.status, 201);

    const again = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "w2", 13, "2026-09-20T12:00:00+08:00")
    );
    assert.equal(again.body.triggered.length, 1);
  } finally {
    await h.stop();
  }
});

test("生态调查：仅取得脱敏分段汇总，无效观测不计入", async () => {
  const h = await startHarness();
  try {
    await seedSegment(h);
    await h.request("POST", "/v1/observations", [
      observation("DUNE-A-W", "e1", 12, "2026-09-20T09:00:00+08:00"),
      observation("DUNE-A-W", "e2", 4, "2026-09-20T10:00:00+08:00"),
      observation("DUNE-A-W", "e3", 99, "2026-09-20T11:00:00+08:00", { quality_flag: "bad" }),
      observation("DUNE-A-M", "e4", 5, "2026-09-20T09:30:00+08:00", { is_backfill: true })
    ]);

    // 无令牌/错误角色
    assert.equal((await h.request("GET", "/v1/eco/segment-summary", undefined, null)).status, 401);
    assert.equal((await h.request("GET", "/v1/eco/segment-summary", undefined, "ranger")).status, 403);
    assert.equal((await h.request("GET", "/v1/eco/segment-summary", undefined, "ingest")).status, 403);

    const r = await h.request("GET", "/v1/eco/segment-summary", undefined, "eco");
    assert.equal(r.status, 200);
    const row = r.body.segments.find((s) => s.segment_ref === "DUNE-A");
    assert.equal(row.valid_observation_count, 3); // bad 读数不计入
    assert.equal(row.wind_speed_mps.avg, 8);
    assert.equal(row.wind_speed_mps.extreme, 12);
    assert.equal(row.soil_moisture_pct.avg, 5);
    assert.equal(row.backfill_count, 1);

    // 脱敏：响应中不得出现设备编号、来源编号、人员与补给字段
    const raw = JSON.stringify(r.body);
    for (const forbidden of ["DUNE-A-W", "DUNE-A-M", "source_record_id", "reviewer", "water", "decided_by"]) {
      assert.ok(!raw.includes(forbidden), `响应包含敏感字段：${forbidden}`);
    }

    // 生态角色不得访问巡护接口
    assert.equal((await h.request("GET", "/v1/risk-assessments", undefined, "eco")).status, 403);
    assert.equal((await h.request("GET", "/v1/openings", undefined, "eco")).status, 403);
  } finally {
    await h.stop();
  }
});

test("不同时区偏移与迟到补报：按真实时刻还原先后，不重开已处理风险", async () => {
  const h = await startHarness();
  try {
    await seedSegment(h);
    // 01:30Z = 09:30+08:00，先上报越限（UTC 字符串）
    let r = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "z1", 12, "2026-09-20T01:30:00Z")
    );
    assert.equal(r.body.triggered.length, 1);
    const id = (await h.request("GET", "/v1/risk-assessments?status=open")).body.assessments[0].id;
    await h.request("POST", `/v1/risk-assessments/${id}/reviews`, {
      action: "resolve",
      reviewer_ref: "ranger-li"
    });

    // 更晚的真实时刻（02:00Z = 10:00+08:00）安全读数
    r = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "z2", 5, "2026-09-20T02:00:00Z")
    );
    assert.equal(r.body.triggered.length, 0);

    // 迟到补报 01:00Z（早于已处理事件）的越限读数：不得重开历史风险
    r = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "z3", 13, "2026-09-20T01:00:00Z", { is_backfill: true }),
      "ingest"
    );
    assert.equal(r.body.triggered.length, 0);
    assert.equal(r.body.accepted_count, 1);

    // 03:00Z 再次越限（+08:00 偏移表达）：可重新触发
    r = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "z4", 14, "2026-09-20T11:00:00+08:00")
    );
    assert.equal(r.body.triggered.length, 1);
  } finally {
    await h.stop();
  }
});

test("墒情与风共同越限时给出 both 原因", async () => {
  const h = await startHarness();
  try {
    await seedSegment(h);
    await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-W", "b1", 12, "2026-09-20T09:00:00+08:00")
    );
    // 风暂停已存在；解除后再让墒情越限，另一要素仍处于越限水平
    const id = (await h.request("GET", "/v1/risk-assessments?status=open")).body.assessments[0].id;
    await h.request("POST", `/v1/risk-assessments/${id}/reviews`, {
      action: "resolve",
      reviewer_ref: "ranger-li"
    });
    const r = await h.request(
      "POST",
      "/v1/observations",
      observation("DUNE-A-M", "b2", 5, "2026-09-20T12:00:00+08:00")
    );
    assert.equal(r.body.triggered[0].reason, "both");
  } finally {
    await h.stop();
  }
});
