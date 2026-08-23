export function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  const percentage = rate * 100;
  if (Number.isInteger(percentage)) return `${percentage}%`;
  return `${percentage.toFixed(1)}%`;
}

export function formatScore(score: number | null, maxPoints: number): string {
  if (score === null || !Number.isFinite(score)) return "—";
  const formatted = score.toFixed(2).replace(/\.?(0+)$/, "");
  return `${formatted} / ${maxPoints}`;
}
