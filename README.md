# 沙漠徒步生态监测与补给

连接现场传感器、路段巡护与补给调度的后端：不同设备的风速/墒情读数带时间与质量标记上报，断联补报还原先后顺序；只有有效观测才触发路段风险判断；补给队在有限水量下决定是否开放下一路段；生态调查仅取得脱敏分段汇总。

本服务采用 HTTP 接口和 SQLite 本地文件（`node:sqlite`）。运行参数 `PORT` 指定监听端口，`DATABASE_PATH` 指定数据文件；`fixtures/example.json` 保存不含真实身份的交换示例，`contracts/entities.json` 记录字段约定，`docs/domain.md` 介绍领域规则。

## 角色令牌

通过环境变量配置三类 Bearer 令牌（未配置的角色不可用）：

| 变量 | 角色 | 能力 |
| --- | --- | --- |
| `GATEWAY_TOKEN` | 设备接入网关 | 上报观测 |
| `RANGER_TOKEN` | 巡护/调度 | 登记路段/设备/补给站、风险查看与人工复核、开放预约（也可上报观测） |
| `ECO_TOKEN` | 生态调查 | 仅 `GET /v1/eco/segment-summary` 脱敏汇总 |

## 接口一览

- `POST /v1/admin/segments` / `/v1/admin/devices` / `/v1/admin/supply-stations`：基础数据登记
- `POST /v1/observations`：观测上报（单条或数组），返回接收/去重/拒绝数量及本次触发的风险
- `GET /v1/risk-assessments[?status=&segment_ref=]`、`GET /v1/risk-assessments/{id}`：风险列表与详情（含触发原始观测）
- `POST /v1/risk-assessments/{id}/reviews`：人工复核，`action` 为 `confirm` 或 `resolve`
- `POST /v1/openings`：开放决定（`headcount`、`idempotency_key` 必填），原子扣减补给水量
- `POST /v1/openings/{id}/cancel`：取消预约并归还水量；`GET /v1/openings` 查询
- `GET /v1/eco/segment-summary[?from=&to=]`：生态脱敏分段汇总

## 本地开发

`make migrate` 初始化数据文件，`make test` 运行自动化检查，`make run` 启动服务。`docker compose up --build` 可以启动隔离容器，`APP_PORT` 可调整宿主机端口；令牌通过同名环境变量注入（见 `compose.yaml`）。

快速试跑：

```bash
GATEWAY_TOKEN=gw RANGER_TOKEN=ranger ECO_TOKEN=eco make run &
curl -s localhost:8080/health
curl -s -X POST localhost:8080/v1/admin/supply-stations \
  -H "authorization: Bearer ranger" -H "content-type: application/json" \
  -d '{"ref":"WELL-1","name":"一号水源","water_liters_available":100}'
curl -s -X POST localhost:8080/v1/admin/segments \
  -H "authorization: Bearer ranger" -H "content-type: application/json" \
  -d '{"ref":"DUNE-A","name":"草方格A段","supply_station_ref":"WELL-1"}'
curl -s -X POST localhost:8080/v1/admin/devices \
  -H "authorization: Bearer ranger" -H "content-type: application/json" \
  -d '{"ref":"DUNE-A-W","metric":"wind_speed","segment_ref":"DUNE-A"}'
curl -s -X POST localhost:8080/v1/observations \
  -H "authorization: Bearer gw" -H "content-type: application/json" \
  -d '{"source_record_id":"s1","device_ref":"DUNE-A-W","value":12,"observed_at":"2026-09-20T09:00:00+08:00"}'
```
