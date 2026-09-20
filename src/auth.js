
// 极简 Bearer Token 鉴权：网关（设备接入）、巡护、生态调查三类角色
// 令牌通过环境变量配置；未配置对应令牌时该角色不可用。

function loadTokens(env = process.env) {
  return {
    ingest: env.GATEWAY_TOKEN || null,
    ranger: env.RANGER_TOKEN || null,
    eco: env.ECO_TOKEN || null
  };
}

function authenticate(tokens, authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "missing_bearer_token" };
  }
  const token = authorization.slice("Bearer ".length).trim();
  const role = Object.entries(tokens).find(([, value]) => value && token === value)?.[0];
  if (!role) return { ok: false, status: 401, error: "invalid_token" };
  return { ok: true, role };
}

// role ∈ 'ingest' | 'ranger' | 'eco'；ranger 可兼任设备接入
function requireRole(tokens, authorization, allowed) {
  const result = authenticate(tokens, authorization);
  if (!result.ok) return result;
  const effective =
    result.role === "ranger" && !allowed.includes("ranger") && allowed.includes("ingest")
      ? "ingest"
      : result.role;
  if (!allowed.includes(effective)) {
    return { ok: false, status: 403, error: "forbidden_role", role: result.role };
  }
  return { ok: true, role: effective };
}

module.exports = { loadTokens, authenticate, requireRole };
