import { control } from "./contract.js";

export function expireRelay(meta, now) {
  if (!meta || meta.status === "CLOSED" || meta.status === "EXPIRED" || now < meta.expiresAt) {
    return meta;
  }
  return { ...meta, status: "EXPIRED", ticketHash: null, ticketExpiresAt: null,
    teacherHeartbeatDeadline: null };
}

export function expireTeacher(meta, now) {
  if (meta?.status !== "OPEN" || !Number.isFinite(meta.teacherHeartbeatDeadline)
    || now < meta.teacherHeartbeatDeadline) return meta;
  return { ...meta, status: "TEACHER_OFFLINE", teacherHeartbeatDeadline: null };
}

export function ensureTeacherDeadline(meta, now, timeoutMs) {
  if (meta?.status !== "OPEN" || Number.isFinite(meta.teacherHeartbeatDeadline)) return meta;
  // Seed once for sockets surviving an upgrade from a relay without liveness
  // metadata. Subsequent wake-ups must preserve, rather than extend, this bound.
  return { ...meta, teacherHeartbeatDeadline: now + timeoutMs };
}

export function disconnectTeacher(meta, attachment) {
  if (attachment?.role !== "teacher" || meta?.status !== "OPEN"
    || meta.teacherGeneration !== attachment.generation) return meta;
  return { ...meta, status: "TEACHER_OFFLINE", teacherHeartbeatDeadline: null };
}

export function invalidateStudents(ctx, meta, now, authTimeoutMs = 5000) {
  const students = ctx.getWebSockets("student");
  for (const student of students) {
    try {
      const attachment = student.deserializeAttachment();
      if (!attachment) { student.close(1008, "Invalid connection"); continue; }
      const online = meta?.status === "OPEN";
      const generation = meta?.teacherGeneration ?? attachment.generation;
      student.serializeAttachment({ role: "student", connectionId: attachment.connectionId, generation,
        authState: online ? "UNAUTHENTICATED" : "TEACHER_OFFLINE",
        authDeadline: online ? now + authTimeoutMs : null, authRequestId: null });
      student.send(control(online ? "REAUTH_REQUIRED" : "teacher_offline", crypto.randomUUID(), { generation }));
    } catch {
      // One disconnected recipient must not prevent the other idle Students
      // from receiving the current generation's proactive control event.
      try { student.close(1008, "Connection unavailable"); } catch { /* already closed */ }
    }
  }
  return students.length;
}
