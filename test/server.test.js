
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const test = require("node:test");
const { createServer } = require("../src/server");

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desert-hike-"));
  const server = createServer({ databasePath: path.join(dir, "test.sqlite3") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = (method, pathname, { role, body } = {}) =>
    fetch(base + pathname, {
      method,
      headers: {
        "content-type": "application/json",
        ...(role ? { "x-role": role } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (response) => ({ status: response.status, body: await response.json() }));
  return { server, call };
}

const VALID_OBSERVATION = {
  source_ref: "SRC-1",
  device_ref: "SENSOR-A",
  segment_ref: "DUNE-A",
  observed_at: "2026-09-20T08:00:00+08:00",
  wind_speed: 6,
  soil_moisture: 20,
};

test("健康接口返回服务状态", async (context) => {
  const { server, call } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await call("GET", "/health");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: "ok" });
});

test("观测上报带时间与质量标记，断联补报按 source_ref 去重", async (context) => {
  const { server, call } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const first = await call("POST", "/observations", { role: "sensor", body: VALID_OBSERVATION });
  assert.equal(first.status, 200);
  assert.equal(first.body.observations[0].quality, "valid");
  assert.equal(first.body.observations[0].deduplicated, false);

  // 断联恢复后重发同一条：内容一致则幂等去重，不重复入库
  const replay = await call("POST", "/observations", { role: "sensor", body: VALID_OBSERVATION });
  assert.equal(replay.body.observations[0].deduplicated, true);

  // 同一 source_ref 但内容不同：拒绝
  const conflict = await call("POST", "/observations", {
    role: "sensor",
    body: { ...VALID_OBSERVATION, wind_speed: 9 },
  });
  assert.equal(conflict.status, 409);

  const list = await call("GET", "/segments/DUNE-A/observations", { role: "ranger" });
  assert.equal(list.body.observations.length, 1);
});

test("补报乱序到达时按观测时间还原先后", async (context) => {
  const { server, call } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const later = { ...VALID_OBSERVATION, source_ref: "SRC-2", observed_at: "2026-09-20T10:00:00+08:00" };
  const earlier = { ...VALID_OBSERVATION, source_ref: "SRC-3", observed_at: "2026-09-20T07:30:00+08:00" };
  await call("POST", "/observations", { role: "sensor", body: later });
  await call("POST", "/observations", { role: "sensor", body: earlier });

  const list = await call("GET", "/segments/DUNE-A/observations", { role: "ranger" });
  assert.deepEqual(
    list.body.observations.map((row) => row.source_ref),
    ["SRC-3", "SRC-1", "SRC-2"].filter((ref) => ref !== "SRC-1")
  );
});

test("只有有效观测触发路段风险，复核后可解除暂停", async (context) => {
  const { server, call } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));

  // 无效质量的越限读数不触发风险
  const invalid = await call("POST", "/observations", {
    role: "sensor",
    body: { ...VALID_OBSERVATION, source_ref: "SRC-BAD", wind_speed: 30, quality: "invalid" },
  });
  assert.equal(invalid.body.risk_events.length, 0);

  // 有效观测越限触发风险事件
  const breach = await call("POST", "/observations", {
    role: "sensor",
    body: { ...VALID_OBSERVATION, source_ref: "SRC-WIND", wind_speed: 20 },
  });
  assert.equal(breach.status, 201);
  assert.equal(breach.body.risk_events.length, 1);
  const eventId = breach.body.risk_events[0].id;
  assert.equal(breach.body.risk_events[0].reason, "high_wind");

  // 已有未解除事件时不重复生成
  const again = await call("POST", "/observations", {
    role: "sensor",
    body: { ...VALID_OBSERVATION, source_ref: "SRC-WIND-2", wind_speed: 25 },
  });
  assert.equal(again.body.risk_events.length, 0);

  // 巡护可见触发暂停的原始观测
  const events = await call("GET", "/segments/DUNE-A/risk-events", { role: "ranger" });
  assert.equal(events.body.risk_events[0].triggering_observation.source_ref, "SRC-WIND");

  // 开放决定：暂停期间 hold
  const check = await call("POST", "/segments/DUNE-A/opening-checks", {
    role: "supply",
    body: { team_size: 12, water_liters: 30 },
  });
  assert.equal(check.body.decision, "hold");
  assert.equal(check.body.reasons[0].code, "segment_paused");

  // 人工复核解除后恢复可开放判断（此时无补给站，水量 0，30L 不足）
  const review = await call("POST", `/risk-events/${eventId}/reviews`, {
    role: "ranger",
    body: { reviewer_ref: "RANGER-1", decision: "release", note: "阵风已过" },
  });
  assert.equal(review.body.risk_event.status, "released");
});

test("预约库存幂等且不能超占，取消后释放", async (context) => {
  const { server, call } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));

  await call("POST", "/stations", {
    role: "ranger",
    body: { station_ref: "ST-A", segment_ref: "DUNE-A", water_capacity_liters: 100 },
  });

  const booking = { request_ref: "REQ-1", station_ref: "ST-A", team_ref: "TEAM-1", team_size: 10, water_liters: 60 };
  const first = await call("POST", "/reservations", { role: "supply", body: booking });
  assert.equal(first.status, 201);

  // 重复提交同一 request_ref：返回原预约，不重复占用
  const replay = await call("POST", "/reservations", { role: "supply", body: booking });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.deduplicated, true);
  let station = await call("GET", "/stations/ST-A", { role: "supply" });
  assert.equal(station.body.water_reserved_liters, 60);

  // 同一 request_ref 不同内容：冲突
  const conflict = await call("POST", "/reservations", {
    role: "supply",
    body: { ...booking, water_liters: 10 },
  });
  assert.equal(conflict.status, 409);

  // 超出剩余水量：拒绝
  const over = await call("POST", "/reservations", {
    role: "supply",
    body: { ...booking, request_ref: "REQ-2", water_liters: 50 },
  });
  assert.equal(over.status, 409);
  assert.equal(over.body.error, "insufficient_water");

  // 取消后库存释放
  await call("POST", "/reservations/REQ-1/cancel", { role: "supply" });
  station = await call("GET", "/stations/ST-A", { role: "supply" });
  assert.equal(station.body.water_remaining_liters, 100);
});

test("生态调查只能取得脱敏汇总，看不到原始观测", async (context) => {
  const { server, call } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));

  await call("POST", "/observations", {
    role: "sensor",
    body: [
      VALID_OBSERVATION,
      { ...VALID_OBSERVATION, source_ref: "SRC-2", observed_at: "2026-09-20T09:00:00+08:00", wind_speed: 10 },
      { ...VALID_OBSERVATION, source_ref: "SRC-3", quality: "suspect", wind_speed: 99 },
    ],
  });

  // researcher 访问原始观测被拒绝
  const denied = await call("GET", "/segments/DUNE-A/observations", { role: "researcher" });
  assert.equal(denied.status, 403);
  const noRole = await call("GET", "/segments/DUNE-A/observations");
  assert.equal(noRole.status, 401);

  // 汇总按日聚合、只含有效观测、不含设备与来源标识
  const summary = await call("GET", "/segments/DUNE-A/summary", { role: "researcher" });
  assert.equal(summary.status, 200);
  assert.equal(summary.body.daily.length, 1);
  const day = summary.body.daily[0];
  assert.equal(day.day, "2026-09-20");
  assert.equal(day.observation_count, 2);
  assert.equal(day.max_wind_speed, 10);
  assert.ok(!("device_ref" in day) && !("source_ref" in day) && !("observed_at" in day));
});

test("开放决定结合预计队伍与水量", async (context) => {
  const { server, call } = await startServer();
  context.after(() => new Promise((resolve) => server.close(resolve)));

  await call("POST", "/stations", {
    role: "ranger",
    body: { station_ref: "ST-B", segment_ref: "DUNE-B", water_capacity_liters: 50 },
  });

  const enough = await call("POST", "/segments/DUNE-B/opening-checks", {
    role: "supply",
    body: { team_size: 8, water_liters: 40 },
  });
  assert.equal(enough.body.decision, "open");

  const short = await call("POST", "/segments/DUNE-B/opening-checks", {
    role: "supply",
    body: { team_size: 20, water_liters: 80 },
  });
  assert.equal(short.body.decision, "hold");
  assert.equal(short.body.reasons[0].code, "insufficient_water");
});
