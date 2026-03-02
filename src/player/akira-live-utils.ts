// reproductor/akira-live-utils.ts
// Helpers opcionales (si querés reutilizar dentro de tu TSX del reproductor)

export const LIVE_TZ = "America/Argentina/Buenos_Aires";

export function parseLiveDate(value?: string | Date | null): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isUpcomingLive(liveMode: boolean, startsAt?: string | Date | null): boolean {
  if (!liveMode) return false;
  const d = parseLiveDate(startsAt);
  if (!d) return false;
  return d.getTime() > Date.now();
}

export function formatCountdown(diffMs: number): string {
  const total = Math.max(0, Math.floor(diffMs / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  const hh = String(hours).padStart(2, "0");
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");

  return days > 0 ? `${days}d ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

export function formatLiveDateTimeAr(value?: string | Date | null) {
  const d = parseLiveDate(value);
  if (!d) return { date: "", time: "", dateTime: "" };

  const date = new Intl.DateTimeFormat("es-AR", {
    timeZone: LIVE_TZ,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);

  const time = new Intl.DateTimeFormat("es-AR", {
    timeZone: LIVE_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

  return { date, time, dateTime: `${date} - ${time}` };
}
