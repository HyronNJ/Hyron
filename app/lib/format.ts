const timeZone = "America/New_York";

export function clock(time: string) {
  return new Date(time).toLocaleTimeString("en-US", { hour: "numeric", timeZone });
}

export function day(time: string) {
  return new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
}

export function riskLevel(score: number) {
  if (score >= 65) return { label: "High", band: "high" };
  if (score >= 38) return { label: "Moderate", band: "moderate" };
  if (score >= 15) return { label: "Low", band: "low" };
  return { label: "Very low", band: "quiet" };
}
