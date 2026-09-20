
// 路段风险阈值与读数合理范围
const WIND_LIMIT_MPS = 10.8; // 平均风速超过约 6 级（10.8 m/s）暂停通行
const MOISTURE_MIN_PCT = 8.0; // 墒情低于 8% 视为干旱胁迫
const WIND_MAX_MPS = 75; // 超出该值视为设备异常读数

module.exports = { WIND_LIMIT_MPS, MOISTURE_MIN_PCT, WIND_MAX_MPS };
