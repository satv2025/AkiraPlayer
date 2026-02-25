import { supabase } from "./supabase";
import { CONFIG } from "../config";

export type ProgressRow = {
  user_id: string;
  content_id: string;
  season_id?: string | null;
  episode_id?: string | null;
  position_seconds: number;
  duration_seconds: number;
  completed: boolean;
  updated_at?: string;
};

type SaveProgressInput = {
  contentId: string;
  positionSeconds: number;
  durationSeconds: number;
  seasonId?: string | null;
  episodeId?: string | null;
};

export async function getCurrentUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    console.warn("[AkiraPlayer] getUser error:", error.message);
    return null;
  }
  return data.user?.id ?? null;
}

export async function loadProgress(params: {
  contentId: string;
  seasonId?: string | null;
  episodeId?: string | null;
}) {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  let query = supabase
    .from("watch_progress")
    .select("*")
    .eq("user_id", userId)
    .eq("content_id", params.contentId);

  if (params.seasonId != null) query = query.eq("season_id", params.seasonId);
  if (params.episodeId != null) query = query.eq("episode_id", params.episodeId);

  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("[AkiraPlayer] loadProgress error:", error.message);
    return null;
  }

  return data;
}

export async function saveProgress(input: SaveProgressInput) {
  const userId = await getCurrentUserId();
  if (!userId) return;

  const nearEndThreshold = Math.max(0, input.durationSeconds - CONFIG.NEAR_END_SECONDS);
  const completed =
    input.durationSeconds > 0 && input.positionSeconds >= nearEndThreshold;

  const payload: ProgressRow = {
    user_id: userId,
    content_id: input.contentId,
    season_id: input.seasonId ?? null,
    episode_id: input.episodeId ?? null,
    position_seconds: Math.floor(input.positionSeconds),
    duration_seconds: Math.floor(input.durationSeconds || 0),
    completed
  };

  const { error } = await supabase.from("watch_progress").upsert(payload, {
    onConflict: "user_id,content_id,season_id,episode_id"
  });

  if (error) {
    console.warn("[AkiraPlayer] saveProgress error:", error.message);
  }
}