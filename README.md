# 沙漠徒步生态监测与补给

路线穿过草方格与滴灌带，风速和墒情来自不同监测设备；补给站的饮水容量需要按实际队伍占用。

本服务采用 HTTP 接口和 SQLite 本地文件。运行参数 `PORT` 指定监听端口，`DATABASE_PATH` 指定数据文件；`fixtures/example.json` 保存不含真实身份的交换示例，`contracts/entities.json` 记录字段与角色约定，`docs/domain.md` 介绍来源与范围。

## 本地开发

`make migrate` 初始化数据文件，`make test` 运行现有自动化检查，`make run` 启动服务。`docker compose up --build` 可以启动隔离容器，`APP_PORT` 可调整宿主机端口。

风险阈值可用环境变量调整：`WIND_SPEED_LIMIT`（默认 14 m/s）、`SOIL_MOISTURE_MIN`（默认 8%）。

## 接口概览

除 `/health` 外，所有接口要求 `x-role` 请求头（sensor / ranger / supply / researcher）。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/observations` | sensor, ranger | 上报单条或批量观测；按 `(device_ref, source_ref)` 幂等去重，有效观测越限自动生成风险事件 |
| GET | `/segments/{ref}/observations` | ranger | 原始观测，按观测时间还原先后 |
| GET | `/segments/{ref}/risk-events` | ranger | 风险事件，含触发观测与复核记录 |
| POST | `/risk-events/{id}/reviews` | ranger | 人工复核：`confirm_pause` 或 `release` |
| POST | `/stations` | ranger | 登记补给站与水容量 |
| GET | `/stations/{ref}` | ranger, supply | 查看容量、已约与剩余水量 |
| POST | `/reservations` | supply, ranger | 预约补给；`request_ref` 幂等，事务内校验库存 |
| POST | `/reservations/{request_ref}/cancel` | supply, ranger | 取消预约并释放库存 |
| POST | `/segments/{ref}/opening-checks` | supply, ranger | 结合路段风险与预计队伍水量给出 open / hold |
| GET | `/segments/{ref}/summary` | researcher, ranger | 脱敏的分段日汇总，仅统计有效观测 |
