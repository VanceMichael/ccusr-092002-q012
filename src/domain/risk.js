
// 风险评估查询与人工复核：巡护人员查看触发暂停的原始观测，并给出维持/解除结论

function getAssessment(database, id) {
  const assessment = database
    .prepare(
      `SELECT id, segment_ref, reason, triggered_at, triggered_by_observation_id,
              status, resolved_at, reviewer_ref, review_note
         FROM risk_assessments WHERE id = ?`
    )
    .get(id);
  if (!assessment) return null;

  // 触发暂停的原始观测（连同评估时使用的另一要素最近有效读数，便于复核）
  const triggerObservation = database
    .prepare(
      `SELECT id, source_record_id, device_ref, metric, value, observed_at,
              quality_flag, is_backfill, ingested_at
         FROM observations WHERE id = ?`
    )
    .get(assessment.triggered_by_observation_id);
  const supporting = database
    .prepare(
      `SELECT id, source_record_id, device_ref, metric, value, observed_at, quality_flag
         FROM observations
        WHERE segment_ref = ? AND valid = 1 AND observed_at_ms <= ?
          AND metric != ?
        ORDER BY observed_at_ms DESC, id DESC LIMIT 1`
    )
    .get(
      assessment.segment_ref,
      Date.parse(triggerObservation.observed_at),
      triggerObservation.metric
    );
  return { ...assessment, trigger_observation: triggerObservation, supporting_observation: supporting };
}

function listAssessments(database, { status, segmentRef } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (segmentRef) {
    clauses.push("segment_ref = ?");
    params.push(segmentRef);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return database
    .prepare(
      `SELECT id, segment_ref, reason, triggered_at, status, resolved_at, reviewer_ref
         FROM risk_assessments ${where} ORDER BY triggered_at_ms DESC, id DESC`
    )
    .all(...params);
}

function reviewAssessment(database, id, { action, reviewerRef, note }) {
  if (!["confirm", "resolve"].includes(action)) {
    return { ok: false, status: 400, error: "invalid_action" };
  }
  if (typeof reviewerRef !== "string" || !reviewerRef) {
    return { ok: false, status: 400, error: "missing_reviewer_ref" };
  }
  const assessment = database
    .prepare("SELECT id, status FROM risk_assessments WHERE id = ?")
    .get(id);
  if (!assessment) return { ok: false, status: 404, error: "assessment_not_found" };
  if (assessment.status === "resolved") {
    return { ok: false, status: 409, error: "assessment_already_resolved" };
  }

  const now = new Date().toISOString();
  if (action === "confirm") {
    database
      .prepare(
        `UPDATE risk_assessments
            SET status = 'confirmed', reviewer_ref = ?, review_note = ? WHERE id = ?`
      )
      .run(reviewerRef, note ?? null, id);
  } else {
    database
      .prepare(
        `UPDATE risk_assessments
            SET status = 'resolved', resolved_at = ?, reviewer_ref = ?, review_note = ?
          WHERE id = ?`
      )
      .run(now, reviewerRef, note ?? null, id);
  }
  return { ok: true, assessment: getAssessment(database, id), reviewed_at: now };
}

module.exports = { getAssessment, listAssessments, reviewAssessment };
