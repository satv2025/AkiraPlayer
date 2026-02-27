// src/lib/progress.ts
import { supabase } from "./supabase";
import { CONFIG } from "../config";

/**
 * AkiraPlayer progress adapter -> public.watch_progress
 *
 * Modelo elegido (robusto para series):
 * - 1 fila por episodio (user_id + movie_id + episode_id)
 * - 1 fila por película (user_id + movie_id, con episode_id = null)
 *
 * UI (Home / Title) puede agrupar por movie_id para mostrar una sola tarjeta por serie.
 */

const PROGRESS_TABLE = "watch_progress";

// Si la tabla todavía no tiene duration_seconds, el código hace fallback.
const TRY_DURATION_COLUMN = true;

type LoadProgressArgs = {
  contentId: string;          // movie_id (película o serie)
  seasonId?: string | null;   // compat (no se persiste)
  episodeId?: string | null;  // episodio actual si es serie
};

type SaveProgressArgs = {
  contentId: string;          // movie_id (película o serie)
  seasonId?: string | null;   // compat (no se persiste)
  episodeId?: string | null;  // episodio actual si es serie
  positionSeconds: number;
  durationSeconds: number;
};

type WatchProgressRow = {
  id?: string;
  user_id: string;
  movie_id: string;
  episode_id: string | null;
  progress_seconds: number;
  updated_at?: string;
  duration_seconds?: number | null;
};

export type AkiraProgressRowShape = {
  // Shape que espera AkiraPlayer hoy
  position_seconds: number;
  duration_seconds: number;
  updated_at?: string | null;

  // extras útiles para validación estricta en frontend
  movie_id?: string;
  episode_id?: string | null;
};

function toInt(value: unknown, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function isUuidLike(v: unknown) {
  return typeof v === "string" && v.length >= 8;
}

async function getCurrentUserId(): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) {
      console.warn("[progress] getUser error:", error);
      return null;
    }
    return data?.user?.id ?? null;
  } catch (e) {
    console.warn("[progress] getUser exception:", e);
    return null;
  }
}

function isNearEnd(positionSeconds: number, durationSeconds: number): boolean {
  const pos = toInt(positionSeconds, 0);
  const dur = toInt(durationSeconds, 0);

  if (!dur || dur <= 0) return false;

  const nearEndThreshold = Number(CONFIG?.NEAR_END_SECONDS ?? 45);
  return (dur - pos) <= nearEndThreshold;
}

function normalizeLoadedRow(row: any): AkiraProgressRowShape | null {
  if (!row) return null;

  return {
    position_seconds: toInt(row.progress_seconds, 0),
    duration_seconds: toInt(row.duration_seconds, 0), // puede venir 0 si no existe la columna
    updated_at: row.updated_at ?? null,
    movie_id: row.movie_id,
    episode_id: row.episode_id ?? null
  };
}

function isMissingDurationColumnError(e: any): boolean {
  const msg = String(e?.message || "").toLowerCase();
  const details = String(e?.details || "").toLowerCase();
  return msg.includes("duration_seconds") || details.includes("duration_seconds");
}

function buildSelectClause(withDuration: boolean) {
  return withDuration
    ? `
      id,
      user_id,
      movie_id,
      episode_id,
      progress_seconds,
      updated_at,
      duration_seconds
    `
    : `
      id,
      user_id,
      movie_id,
      episode_id,
      progress_seconds,
      updated_at
    `;
}

async function selectExactProgressRow(params: {
  userId: string;
  movieId: string;
  episodeId?: string | null;
  withDuration?: boolean;
}): Promise<any | null> {
  const { userId, movieId, episodeId = null, withDuration = true } = params;

  const selectClause = buildSelectClause(withDuration);

  let q = supabase
    .from(PROGRESS_TABLE)
    .select(selectClause)
    .eq("user_id", userId)
    .eq("movie_id", movieId);

  // Exact match:
  // - película => episode_id IS NULL
  // - serie    => episode_id = <uuid>
  if (episodeId) {
    q = q.eq("episode_id", episodeId);
  } else {
    q = q.is("episode_id", null);
  }

  const { data, error } = await q
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

async function selectLatestProgressForMovie(params: {
  userId: string;
  movieId: string;
  withDuration?: boolean;
}): Promise<any | null> {
  const { userId, movieId, withDuration = true } = params;

  const selectClause = buildSelectClause(withDuration);

  const { data, error } = await supabase
    .from(PROGRESS_TABLE)
    .select(selectClause)
    .eq("user_id", userId)
    .eq("movie_id", movieId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

/**
 * loadProgress()
 * ✅ EXACTO (sin fallback al "último episodio de la serie")
 *
 * Devuelve shape compatible con AkiraPlayer:
 * {
 *   position_seconds,
 *   duration_seconds,
 *   updated_at
 * }
 *
 * - Película: busca (user_id, movie_id, episode_id IS NULL)
 * - Serie:    busca (user_id, movie_id, episode_id = exacto)
 */
export async function loadProgress(args: LoadProgressArgs): Promise<AkiraProgressRowShape | null> {
  const { contentId, episodeId = null } = args || {};

  if (!isUuidLike(contentId)) return null;

  const userId = await getCurrentUserId();
  if (!userId) return null;

  try {
    let row: any | null = null;

    // Intento con duration_seconds si existe
    if (TRY_DURATION_COLUMN) {
      try {
        row = await selectExactProgressRow({
          userId,
          movieId: contentId,
          episodeId,
          withDuration: true
        });

        return normalizeLoadedRow(row);
      } catch (e: any) {
        if (!isMissingDurationColumnError(e)) throw e;
        console.warn("[progress] duration_seconds no existe; continúo sin esa columna");
      }
    }

    // Fallback sin duration_seconds
    row = await selectExactProgressRow({
      userId,
      movieId: contentId,
      episodeId,
      withDuration: false
    });

    return normalizeLoadedRow(row);
  } catch (e) {
    console.warn("[progress] loadProgress error:", e);
    return null;
  }
}

/**
 * loadLatestSeriesProgress()
 * ✅ Devuelve el ÚLTIMO progreso de una serie (cualquier episodio)
 *
 * Usar para "Continuar viendo" / Home / card de serie.
 * NO usar para hidratar progreso por episodio en el modal.
 */
export async function loadLatestSeriesProgress(contentId: string): Promise<AkiraProgressRowShape | null> {
  if (!isUuidLike(contentId)) return null;

  const userId = await getCurrentUserId();
  if (!userId) return null;

  try {
    let row: any | null = null;

    if (TRY_DURATION_COLUMN) {
      try {
        row = await selectLatestProgressForMovie({
          userId,
          movieId: contentId,
          withDuration: true
        });
        return normalizeLoadedRow(row);
      } catch (e: any) {
        if (!isMissingDurationColumnError(e)) throw e;
        console.warn("[progress] duration_seconds no existe; continúo sin esa columna (latest series)");
      }
    }

    row = await selectLatestProgressForMovie({
      userId,
      movieId: contentId,
      withDuration: false
    });

    return normalizeLoadedRow(row);
  } catch (e) {
    console.warn("[progress] loadLatestSeriesProgress error:", e);
    return null;
  }
}

async function deleteWatchProgressRow(params: {
  userId: string;
  movieId: string;
  episodeId?: string | null;
}) {
  const { userId, movieId, episodeId = null } = params;

  let q = supabase
    .from(PROGRESS_TABLE)
    .delete()
    .eq("user_id", userId)
    .eq("movie_id", movieId);

  // ✅ borrar EXACTO:
  // - película => solo la fila con episode_id NULL
  // - serie    => solo ese episodio
  if (episodeId) q = q.eq("episode_id", episodeId);
  else q = q.is("episode_id", null);

  const { error } = await q;
  if (error) throw error;
}

async function updateMovieRow(params: {
  userId: string;
  movieId: string;
  progressSeconds: number;
  durationSeconds: number;
  withDuration?: boolean;
}): Promise<"updated" | "not_found"> {
  const {
    userId,
    movieId,
    progressSeconds,
    durationSeconds,
    withDuration = true
  } = params;

  const payloadBase = {
    progress_seconds: progressSeconds,
    updated_at: new Date().toISOString()
  };

  const payload = withDuration
    ? { ...payloadBase, duration_seconds: durationSeconds }
    : payloadBase;

  const { data, error } = await supabase
    .from(PROGRESS_TABLE)
    .update(payload as any)
    .eq("user_id", userId)
    .eq("movie_id", movieId)
    .is("episode_id", null)
    .select("id")
    .limit(1);

  if (error) throw error;

  return data && data.length > 0 ? "updated" : "not_found";
}

async function insertMovieRow(params: {
  userId: string;
  movieId: string;
  progressSeconds: number;
  durationSeconds: number;
  withDuration?: boolean;
}) {
  const {
    userId,
    movieId,
    progressSeconds,
    durationSeconds,
    withDuration = true
  } = params;

  const payloadBase: WatchProgressRow = {
    user_id: userId,
    movie_id: movieId,
    episode_id: null,
    progress_seconds: progressSeconds,
    updated_at: new Date().toISOString()
  };

  const payload = withDuration
    ? { ...payloadBase, duration_seconds: durationSeconds }
    : payloadBase;

  const { error } = await supabase
    .from(PROGRESS_TABLE)
    .insert(payload as any);

  if (error) throw error;
}

/**
 * Guardado de película (episode_id = null)
 * ⚠️ No usamos upsert con (user_id,movie_id,episode_id) porque NULL no colisiona como esperás.
 */
async function saveMovieProgress(params: {
  userId: string;
  movieId: string;
  progressSeconds: number;
  durationSeconds: number;
}) {
  const { userId, movieId, progressSeconds, durationSeconds } = params;

  // Intentar con duration_seconds
  if (TRY_DURATION_COLUMN) {
    try {
      const result = await updateMovieRow({
        userId,
        movieId,
        progressSeconds,
        durationSeconds,
        withDuration: true
      });

      if (result === "updated") return;

      await insertMovieRow({
        userId,
        movieId,
        progressSeconds,
        durationSeconds,
        withDuration: true
      });

      return;
    } catch (e: any) {
      // Si no existe duration_seconds, reintentamos sin esa columna
      if (!isMissingDurationColumnError(e)) {
        // Si hubo race condition / unique violation en insert, reintentá update una vez
        const msg = String(e?.message || "").toLowerCase();
        if (msg.includes("duplicate key") || msg.includes("unique")) {
          try {
            await updateMovieRow({
              userId,
              movieId,
              progressSeconds,
              durationSeconds,
              withDuration: true
            });
            return;
          } catch {
            // seguimos abajo
          }
        }
        throw e;
      }

      console.warn("[progress] duration_seconds no existe; guardando película sin esa columna");
    }
  }

  // Fallback sin duration_seconds
  const result = await updateMovieRow({
    userId,
    movieId,
    progressSeconds,
    durationSeconds,
    withDuration: false
  });

  if (result === "updated") return;

  try {
    await insertMovieRow({
      userId,
      movieId,
      progressSeconds,
      durationSeconds,
      withDuration: false
    });
  } catch (e: any) {
    // race condition por índice parcial (si lo agregás)
    const msg = String(e?.message || "").toLowerCase();
    if (msg.includes("duplicate key") || msg.includes("unique")) {
      await updateMovieRow({
        userId,
        movieId,
        progressSeconds,
        durationSeconds,
        withDuration: false
      });
      return;
    }
    throw e;
  }
}

/**
 * Guardado de episodio (serie)
 * Acá sí usamos upsert por triple:
 * (user_id, movie_id, episode_id)
 */
async function saveEpisodeProgress(params: {
  userId: string;
  movieId: string;
  episodeId: string;
  progressSeconds: number;
  durationSeconds: number;
}) {
  const { userId, movieId, episodeId, progressSeconds, durationSeconds } = params;

  const payloadBase: WatchProgressRow = {
    user_id: userId,
    movie_id: movieId,
    episode_id: episodeId,
    progress_seconds: progressSeconds,
    updated_at: new Date().toISOString()
  };

  const payloadWithDuration = {
    ...payloadBase,
    duration_seconds: durationSeconds
  };

  // Primero intentamos con duration_seconds
  if (TRY_DURATION_COLUMN) {
    const { error } = await supabase
      .from(PROGRESS_TABLE)
      .upsert(payloadWithDuration as any, {
        onConflict: "user_id,movie_id,episode_id"
      });

    if (!error) return;

    if (!isMissingDurationColumnError(error)) throw error;
    console.warn("[progress] duration_seconds no existe; guardando episodio sin esa columna");
  }

  // Fallback sin duration_seconds
  const { error } = await supabase
    .from(PROGRESS_TABLE)
    .upsert(payloadBase as any, {
      onConflict: "user_id,movie_id,episode_id"
    });

  if (error) throw error;
}

/**
 * saveProgress()
 * - Película: guarda fila con episode_id = null
 * - Serie: guarda fila por episodio (user_id + movie_id + episode_id)
 */
export async function saveProgress(args: SaveProgressArgs): Promise<void> {
  const {
    contentId,
    episodeId = null,
    positionSeconds,
    durationSeconds
  } = args || ({} as SaveProgressArgs);

  if (!isUuidLike(contentId)) return;

  const userId = await getCurrentUserId();
  if (!userId) {
    // Usuario no logueado => noop (si querés luego agregamos localStorage fallback)
    return;
  }

  const pos = toInt(positionSeconds, 0);
  const dur = toInt(durationSeconds, 0);

  if (!dur || dur <= 0) return;

  // Si terminó (o casi), limpiamos SOLO la fila exacta
  if (isNearEnd(pos, dur)) {
    try {
      await deleteWatchProgressRow({
        userId,
        movieId: contentId,
        episodeId
      });
    } catch (e) {
      console.warn("[progress] delete near-end error:", e);
    }
    return;
  }

  try {
    // Serie (por episodio)
    if (episodeId && isUuidLike(episodeId)) {
      await saveEpisodeProgress({
        userId,
        movieId: contentId,
        episodeId,
        progressSeconds: pos,
        durationSeconds: dur
      });
      return;
    }

    // Película (episode_id = null)
    await saveMovieProgress({
      userId,
      movieId: contentId,
      progressSeconds: pos,
      durationSeconds: dur
    });
  } catch (e) {
    console.warn("[progress] saveProgress error:", e);
  }
}