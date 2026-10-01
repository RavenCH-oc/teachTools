export function expireRelay(meta, now) {
  if (!meta || meta.status === "CLOSED" || meta.status === "EXPIRED" || now < meta.expiresAt) {
    return meta;
  }
  return { ...meta, status: "EXPIRED", ticketHash: null, ticketExpiresAt: null };
}
