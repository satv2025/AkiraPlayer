// AkiraPlayer.tsx
import Hls from "hls.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SubtitleTrackInput } from "../index";
import { CONFIG } from "../config";
import { supabase } from "../lib/supabase";
import { loadProgress, saveProgress } from "../lib/progress";
import {
    findThumbnailCue,
    loadThumbnailVtt,
    type ThumbnailCue
} from "../lib/vtt-thumbnails";

type RecommendedItem = {
    id: string;
    title: string;
    poster?: string | null;
    type?: "movie" | "series" | string;
    synopsis?: string | null;
};

type EpisodeItem = {
    id: string;
    title: string;
    synopsis?: string | null;

    /** Compat viejo */
    thumbnail?: string | null;

    /** Alias limpio */
    thumbnailEpisode?: string | null;

    /** Columna literal de DB (si llega así) */
    "thumbnails-episode"?: string | null;

    /** Compat snake_case */
    thumbnails_episode?: string | null;

    seasonId?: string | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    durationSeconds?: number | null;
};

type Props = {
    src: string;
    poster?: string;
    autoplay?: boolean;
    title?: string; // puede venir mal (ej. "Episodio 2"), se hidrata desde movies por contentId
    channelLabel?: string;

    assetBase?: string;
    assetBaseUrl?: string;

    contentId: string; // ID de serie o peli abierta (UUID de movies.id)
    seasonId?: string | null;
    episodeId?: string | null;

    thumbnailsVtt?: string;
    subtitles?: SubtitleTrackInput[];

    onBack?: () => void;

    recommendations?: RecommendedItem[];
    episodes?: EpisodeItem[];

    onOpenRecommendations?: () => void;
    onSelectRecommendation?: (item: RecommendedItem) => void;
    onSelectEpisode?: (episodeId: string, episode?: EpisodeItem) => void;

    recommendationsLabel?: string;

    /** ✅ Playlist mode: al terminar, reproduce el siguiente episodio */
    playlistMode?: boolean;
};

type EpisodeProgressInfo = {
    positionSeconds: number;
    durationSeconds: number;
    percent: number;
    hasProgress: boolean;
    completed: boolean;
};

type EpisodesThumbDbRow = {
    id?: string | null;
    "thumbnails-episode"?: string | null;
    thumbnails_episode?: string | null;
    thumbnailEpisode?: string | null;
    thumbnail?: string | null;
};

type MovieTitleDbRow = {
    id?: string | null;
    title?: string | null;
    category?: string | null;
};

type FeedbackState = { text: string; visible: boolean } | null;

type ProgressRowLike = {
    content_id?: string | null;
    contentId?: string | null;
    season_id?: string | null;
    seasonId?: string | null;
    episode_id?: string | null;
    episodeId?: string | null;
    position_seconds?: number | string | null;
    duration_seconds?: number | string | null;
};

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}

function fmtTime(seconds: number): string {
    if (!Number.isFinite(seconds)) return "00:00";
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;

    if (h > 0) {
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    }
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function normalizeMaybeRelativeUrl(input: string): string {
    const value = String(input || "").trim();
    if (!value) return value;

    if (/^(https?:|data:|blob:)/i.test(value)) return value;

    if (value.startsWith("//")) {
        if (typeof window !== "undefined") return `${window.location.protocol}${value}`;
        return `https:${value}`;
    }

    try {
        if (typeof window !== "undefined") {
            return new URL(value, window.location.origin).toString();
        }
    } catch {
        // noop
    }

    return value;
}

function pickEpisodeThumbValue(
    obj: Partial<EpisodeItem> | Partial<EpisodesThumbDbRow> | null | undefined
): string | null {
    if (!obj) return null;

    const src =
        (obj as any)["thumbnails-episode"] ??
        (obj as any).thumbnailEpisode ??
        (obj as any).thumbnails_episode ??
        (obj as any).thumbnail ??
        null;

    if (!src) return null;
    const trimmed = String(src).trim();
    if (!trimmed.length) return null;

    return normalizeMaybeRelativeUrl(trimmed);
}

function getEpisodeThumbSrc(ep: EpisodeItem, hydratedThumb?: string | null): string | null {
    return pickEpisodeThumbValue(ep) ?? (hydratedThumb ? normalizeMaybeRelativeUrl(hydratedThumb) : null);
}

function getIcons(assetBase: string) {
    const safeAssetBase = (assetBase || "/assets").replace(/\/$/, "");
    const base = `${safeAssetBase}/media/icons/svg`;
    return {
        play: `${base}/play.svg`,
        pause: `${base}/pause.svg`,
        backward: `${base}/backward.svg`,
        forward: `${base}/forward.svg`,
        fullscreen: `${base}/fullscreen.svg`,
        windowed: `${base}/windowed.svg`,
        episodes: `${base}/episodes.svg`,
        volume: {
            mute: `${base}/volume/mute.svg`,
            vol0: `${base}/volume/vol0.svg`,
            vol1: `${base}/volume/vol1.svg`,
            vol2: `${base}/volume/vol2.svg`
        }
    };
}

function isSafariLikeForNativeHls(): boolean {
    const ua = navigator.userAgent || "";
    const vendor = navigator.vendor || "";

    const isIOS = /iPhone|iPad|iPod/i.test(ua);

    const isSafariDesktop =
        /Safari/i.test(ua) &&
        !/Chrome|Chromium|Edg|OPR|CriOS|FxiOS|Android/i.test(ua) &&
        /Apple/i.test(vendor);

    return isIOS || isSafariDesktop;
}

function readProgressRowMeta(row: ProgressRowLike | null | undefined) {
    if (!row) {
        return {
            contentId: null as string | null,
            seasonId: null as string | null,
            episodeId: null as string | null
        };
    }

    const contentId =
        row.content_id != null
            ? String(row.content_id)
            : row.contentId != null
                ? String(row.contentId)
                : null;

    const seasonId =
        row.season_id != null
            ? String(row.season_id)
            : row.seasonId != null
                ? String(row.seasonId)
                : null;

    const episodeId =
        row.episode_id != null
            ? String(row.episode_id)
            : row.episodeId != null
                ? String(row.episodeId)
                : null;

    return { contentId, seasonId, episodeId };
}

function isStrictEpisodeProgressRowMatch(params: {
    row: ProgressRowLike | null | undefined;
    contentId: string;
    episodeId: string;
    seasonId?: string | null;
    requireEpisodeId?: boolean;
}): boolean {
    const { row, contentId, episodeId, seasonId, requireEpisodeId = true } = params;
    if (!row) return false;

    const meta = readProgressRowMeta(row);

    // Si el row trae contentId, validar
    if (meta.contentId != null && meta.contentId !== String(contentId)) return false;

    // En listado / restore de episodios, exigimos match de episodeId
    if (requireEpisodeId) {
        if (meta.episodeId == null) return false;
        if (meta.episodeId !== String(episodeId)) return false;
    }

    // Si ambos existen, validar season también
    if (seasonId != null && meta.seasonId != null && String(seasonId) !== String(meta.seasonId)) {
        return false;
    }

    return true;
}

async function loadEpisodesProgressReal(params: {
    contentId: string;
    seasonId?: string | null;
    episodes: EpisodeItem[];
}): Promise<Record<string, EpisodeProgressInfo>> {
    const { contentId, seasonId, episodes } = params;
    const map: Record<string, EpisodeProgressInfo> = {};

    if (!contentId || !episodes.length) return map;

    const entries = await Promise.all(
        episodes.map(async (ep): Promise<[string, EpisodeProgressInfo]> => {
            let row: any = null;

            // ✅ Probamos exacto por season del ep / player, luego fallback null
            // pero SIEMPRE validando el episodeId devuelto
            const seasonCandidates = Array.from(
                new Set<(string | null)>([
                    ep.seasonId ?? null,
                    seasonId ?? null,
                    null
                ])
            );

            for (const sId of seasonCandidates) {
                let candidate: any = null;

                try {
                    candidate = await loadProgress({
                        contentId,
                        seasonId: sId,
                        episodeId: ep.id
                    });
                } catch {
                    candidate = null;
                }

                if (!candidate) continue;

                if (
                    !isStrictEpisodeProgressRowMatch({
                        row: candidate,
                        contentId,
                        episodeId: ep.id,
                        seasonId: ep.seasonId ?? sId ?? null,
                        requireEpisodeId: true
                    })
                ) {
                    continue;
                }

                row = candidate;
                break;
            }

            const positionSeconds = Number((row as any)?.position_seconds || 0);
            const rowDuration = Number((row as any)?.duration_seconds || 0);
            const fallbackDuration = Number(ep.durationSeconds || 0);
            const durationSeconds = rowDuration > 0 ? rowDuration : fallbackDuration;

            const percent =
                durationSeconds > 0
                    ? clamp((positionSeconds / durationSeconds) * 100, 0, 100)
                    : 0;

            const completed =
                durationSeconds > 0 &&
                durationSeconds - positionSeconds <= (CONFIG.NEAR_END_SECONDS ?? 45);

            const hasProgress = positionSeconds > 0;

            return [
                ep.id,
                {
                    positionSeconds,
                    durationSeconds,
                    percent,
                    hasProgress,
                    completed
                }
            ];
        })
    );

    return Object.fromEntries(entries);
}

async function loadEpisodeThumbsFromSupabase(params: {
    episodes: EpisodeItem[];
}): Promise<Record<string, string>> {
    const { episodes } = params;
    const result: Record<string, string> = {};

    const missingIds = episodes
        .filter((ep) => !pickEpisodeThumbValue(ep))
        .map((ep) => String(ep.id || "").trim())
        .filter(Boolean);

    if (!missingIds.length) return result;

    const episodesTable = String((CONFIG as any)?.EPISODES_TABLE || "episodes");

    let data: EpisodesThumbDbRow[] | null = null;
    let err: any = null;

    try {
        const r1 = await (supabase as any)
            .from(episodesTable)
            .select(`id,"thumbnails-episode"`)
            .in("id", missingIds);

        data = (r1.data ?? null) as EpisodesThumbDbRow[] | null;
        err = r1.error ?? null;
    } catch (e) {
        err = e;
        data = null;
    }

    if (err || !data) {
        try {
            const r2 = await (supabase as any)
                .from(episodesTable)
                .select("id,thumbnails_episode,thumbnailEpisode,thumbnail")
                .in("id", missingIds);

            data = (r2.data ?? null) as EpisodesThumbDbRow[] | null;
            err = r2.error ?? null;
        } catch (e) {
            err = e;
            data = null;
        }
    }

    if (err && !data) {
        console.warn("[AkiraPlayer] No se pudieron cargar thumbs desde Supabase (tabla episodes):", err);
        return result;
    }

    for (const row of data || []) {
        const id = String(row?.id || "").trim();
        if (!id) continue;

        const thumb = pickEpisodeThumbValue(row);
        if (thumb) result[id] = thumb;
    }

    return result;
}

/** ✅ Título real de la serie/película desde public.movies por UUID */
async function loadContentTitleFromMovies(params: {
    contentId: string;
}): Promise<{ title: string | null; category: string | null }> {
    const { contentId } = params;
    if (!contentId) return { title: null, category: null };

    const moviesTable = String((CONFIG as any)?.MOVIES_TABLE || "movies");

    try {
        const { data, error } = await (supabase as any)
            .from(moviesTable)
            .select("id,title,category")
            .eq("id", contentId)
            .maybeSingle();

        if (error) {
            console.warn("[AkiraPlayer] Error leyendo title desde movies:", error);
            return { title: null, category: null };
        }

        const row = (data || null) as MovieTitleDbRow | null;
        const title = row?.title ? String(row.title).trim() : null;
        const category = row?.category ? String(row.category).trim() : null;

        return {
            title: title && title.length ? title : null,
            category: category && category.length ? category : null
        };
    } catch (e) {
        console.warn("[AkiraPlayer] Excepción leyendo title desde movies:", e);
        return { title: null, category: null };
    }
}

export function AkiraPlayer({
    src,
    poster,
    autoplay = false,
    title = "AkiraPlayer",
    channelLabel = "SATVPlus",
    assetBase = "/assets",
    assetBaseUrl,
    contentId,
    seasonId,
    episodeId,
    thumbnailsVtt,
    subtitles = [],
    onBack,
    recommendations = [],
    episodes = [],
    onOpenRecommendations,
    onSelectRecommendation,
    onSelectEpisode,
    recommendationsLabel = "Te podría gustar",
    playlistMode = true
}: Props) {
    void channelLabel;

    const resolvedAssetBase = (assetBaseUrl || assetBase || "/assets").replace(/\/$/, "");
    const ICONS = useMemo(() => getIcons(resolvedAssetBase), [resolvedAssetBase]);

    const wrapRef = useRef<HTMLDivElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const progressWrapRef = useRef<HTMLDivElement | null>(null);
    const volumeSliderRef = useRef<HTMLInputElement | null>(null);
    const seasonDropdownRef = useRef<HTMLDivElement | null>(null);

    const hlsRef = useRef<Hls | null>(null);
    const restoredRef = useRef(false);
    const lastSavedAtRef = useRef(0);
    const controlsHideTimerRef = useRef<number | null>(null);
    const feedbackTimerRef = useRef<number | null>(null);

    /** ✅ Para forzar autoplay cuando avanza al siguiente episodio en playlist mode */
    const playlistNextAutoplayRef = useRef(false);

    /** ✅ Evita races y duplicados al hidratar modal */
    const episodesModalHydrationSeqRef = useRef(0);
    const episodesModalHydratedSignatureRef = useRef<string>("");

    const [playing, setPlaying] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [muted, setMuted] = useState(false);
    const [volume, setVolume] = useState(1);

    const [showVolumeSlider, setShowVolumeSlider] = useState(false);

    const [showEpisodes, setShowEpisodes] = useState(false);
    const [showRecommendations, setShowRecommendations] = useState(false);

    const [selectedSeasonNumber, setSelectedSeasonNumber] = useState<number>(1);
    const [showSeasonDropdown, setShowSeasonDropdown] = useState(false);

    const [episodeProgressMap, setEpisodeProgressMap] = useState<Record<string, EpisodeProgressInfo>>({});
    const [episodeThumbsMap, setEpisodeThumbsMap] = useState<Record<string, string>>({});
    const [isEpisodesModalPreparing, setIsEpisodesModalPreparing] = useState(false);

    /** ✅ título/categoría reales desde movies */
    const [contentTitleFromDb, setContentTitleFromDb] = useState<string | null>(null);
    const [contentCategoryFromDb, setContentCategoryFromDb] = useState<string | null>(null);

    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [bufferedEnd, setBufferedEnd] = useState(0);

    const [controlsVisible, setControlsVisible] = useState(true);
    const [isPointerOverPlayer, setIsPointerOverPlayer] = useState(false);

    const [feedback, setFeedback] = useState<FeedbackState>(null);

    const [thumbnailCues, setThumbnailCues] = useState<ThumbnailCue[]>([]);
    const [hoverTime, setHoverTime] = useState<number | null>(null);
    const [hoverX, setHoverX] = useState(0);
    const [showThumbPreview, setShowThumbPreview] = useState(false);

    const anyFloatingOpen =
        showEpisodes || showRecommendations || showVolumeSlider || showSeasonDropdown;

    const showControlsTemporarily = () => {
        setControlsVisible(true);

        if (controlsHideTimerRef.current) {
            window.clearTimeout(controlsHideTimerRef.current);
            controlsHideTimerRef.current = null;
        }

        if (!playing) return;

        controlsHideTimerRef.current = window.setTimeout(() => {
            if (
                !isPointerOverPlayer &&
                !showEpisodes &&
                !showVolumeSlider &&
                !showRecommendations &&
                !showSeasonDropdown
            ) {
                setControlsVisible(false);
            }
        }, 2200);
    };

    const flashFeedback = (text: string) => {
        setFeedback({ text, visible: true });

        if (feedbackTimerRef.current) {
            window.clearTimeout(feedbackTimerRef.current);
            feedbackTimerRef.current = null;
        }

        feedbackTimerRef.current = window.setTimeout(() => {
            setFeedback((prev) => (prev ? { ...prev, visible: false } : prev));
        }, 700);
    };

    const closeFloatingPanels = () => {
        setShowEpisodes(false);
        setShowRecommendations(false);
        setShowVolumeSlider(false);
        setShowSeasonDropdown(false);
    };

    const currentEpisodeData = useMemo(() => {
        if (!episodeId) return null;
        return episodes.find((ep) => ep.id === episodeId) ?? null;
    }, [episodes, episodeId]);

    const isSeriesContext = useMemo(() => {
        // prioridad 1: categoría real desde movies (si ya cargó)
        if (contentCategoryFromDb === "series") return true;
        if (contentCategoryFromDb === "movie") return false;

        // prioridad 2: URL actual
        if (typeof window !== "undefined") {
            try {
                const sp = new URLSearchParams(window.location.search);
                if (sp.has("series")) return true;
                if (sp.has("movie")) return false;
            } catch {
                // noop
            }
        }

        // fallback
        return Boolean(episodeId);
    }, [contentCategoryFromDb, episodeId]);

    const displayContentTitle = useMemo(() => {
        const dbTitle = (contentTitleFromDb || "").trim();
        if (dbTitle) return dbTitle;

        const propTitle = (title || "").trim();
        if (propTitle) return propTitle;

        return "AkiraPlayer";
    }, [contentTitleFromDb, title]);

    const topMetaEpisodeLine = useMemo(() => {
        if (!isSeriesContext) return "";
        const s = currentEpisodeData?.seasonNumber ?? (selectedSeasonNumber || undefined);
        const e = currentEpisodeData?.episodeNumber;
        const epTitle = currentEpisodeData?.title?.trim() || "";

        if (s != null && e != null) return `Temporada ${s} · E${e}${epTitle ? ` ${epTitle}` : ""}`;
        if (s != null && epTitle) return `Temporada ${s} · ${epTitle}`;
        if (epTitle) return epTitle;
        return "";
    }, [isSeriesContext, currentEpisodeData, selectedSeasonNumber]);

    /**
     * ✅ Playlist helpers ANTES del useEffect de video
     * (evita TS2448 / TS2454)
     */
    const orderedEpisodes = useMemo(() => {
        return [...episodes].sort((a, b) => {
            const sa = a.seasonNumber ?? 1;
            const sb = b.seasonNumber ?? 1;
            if (sa !== sb) return sa - sb;

            const ea = a.episodeNumber ?? 0;
            const eb = b.episodeNumber ?? 0;
            if (ea !== eb) return ea - eb;

            return String(a.id).localeCompare(String(b.id));
        });
    }, [episodes]);

    const currentEpisodeIndexInPlaylist = useMemo(() => {
        if (!episodeId) return -1;
        return orderedEpisodes.findIndex((ep) => ep.id === episodeId);
    }, [orderedEpisodes, episodeId]);

    const nextEpisodeInPlaylist = useMemo(() => {
        if (currentEpisodeIndexInPlaylist < 0) return null;
        return orderedEpisodes[currentEpisodeIndexInPlaylist + 1] ?? null;
    }, [orderedEpisodes, currentEpisodeIndexInPlaylist]);

    /** ✅ Season efectivo para progresos del episodio actual */
    const effectiveSeasonIdForCurrentEpisode = useMemo(() => {
        return currentEpisodeData?.seasonId ?? seasonId ?? null;
    }, [currentEpisodeData, seasonId]);

    /** ✅ Firma para saber si ya hidratamos el modal con este set de episodios */
    const episodesModalDataSignature = useMemo(() => {
        const compact = episodes.map((ep) => [
            String(ep.id),
            ep.seasonId ?? null,
            ep.seasonNumber ?? null,
            ep.episodeNumber ?? null,
            ep.durationSeconds ?? null,
            Boolean(pickEpisodeThumbValue(ep))
        ]);
        return JSON.stringify({
            contentId: String(contentId || ""),
            seasonId: seasonId ?? null,
            episodes: compact
        });
    }, [contentId, seasonId, episodes]);

    const hydrateEpisodesModalData = useCallback(
        async (opts?: { force?: boolean }) => {
            const force = Boolean(opts?.force);

            if (!contentId || !episodes.length) {
                setEpisodeProgressMap({});
                setEpisodeThumbsMap({});
                episodesModalHydratedSignatureRef.current = episodesModalDataSignature;
                return;
            }

            // ✅ Evita rehacer trabajo si ya está fresco
            if (!force && episodesModalHydratedSignatureRef.current === episodesModalDataSignature) {
                return;
            }

            const seq = ++episodesModalHydrationSeqRef.current;
            setIsEpisodesModalPreparing(true);

            try {
                const [progressMap, thumbsMap] = await Promise.all([
                    loadEpisodesProgressReal({
                        contentId,
                        seasonId,
                        episodes
                    }),
                    loadEpisodeThumbsFromSupabase({ episodes })
                ]);

                if (episodesModalHydrationSeqRef.current !== seq) return;

                setEpisodeProgressMap(progressMap);
                setEpisodeThumbsMap((prev) => ({ ...prev, ...thumbsMap }));
                episodesModalHydratedSignatureRef.current = episodesModalDataSignature;
            } catch (e) {
                console.warn("[AkiraPlayer] Error hidratando data del modal de episodios:", e);
                if (episodesModalHydrationSeqRef.current !== seq) return;
                // igual marcamos firma para no entrar en loop agresivo
                episodesModalHydratedSignatureRef.current = episodesModalDataSignature;
            } finally {
                if (episodesModalHydrationSeqRef.current === seq) {
                    setIsEpisodesModalPreparing(false);
                }
            }
        },
        [contentId, seasonId, episodes, episodesModalDataSignature]
    );

    const goBackToOpenedTitle = () => {
        if (onBack) {
            onBack();
            return;
        }

        try {
            const current = new URL(window.location.href);
            const sp = current.searchParams;

            let targetUrl = "";
            if (sp.has("series") || isSeriesContext) {
                targetUrl = `/title?series=${encodeURIComponent(contentId)}`;
            } else if (sp.has("movie")) {
                targetUrl = `/title?movie=${encodeURIComponent(contentId)}`;
            } else {
                targetUrl = `/title?id=${encodeURIComponent(contentId)}`;
            }

            window.location.assign(targetUrl);
        } catch {
            window.location.assign(
                isSeriesContext
                    ? `/title?series=${encodeURIComponent(contentId)}`
                    : `/title?id=${encodeURIComponent(contentId)}`
            );
        }
    };

    // ✅ Hidratar título real desde movies por UUID (contentId)
    useEffect(() => {
        let cancelled = false;

        (async () => {
            if (!contentId) {
                if (!cancelled) {
                    setContentTitleFromDb(null);
                    setContentCategoryFromDb(null);
                }
                return;
            }

            const { title: movieTitle, category } = await loadContentTitleFromMovies({ contentId });

            if (!cancelled) {
                setContentTitleFromDb(movieTitle);
                setContentCategoryFromDb(category);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [contentId]);

    // HLS setup
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !src) return;

        restoredRef.current = false;

        if (hlsRef.current) {
            try {
                hlsRef.current.destroy();
            } catch {
                // noop
            }
            hlsRef.current = null;
        }

        try {
            video.pause();
        } catch {
            // noop
        }

        try {
            video.removeAttribute("src");
            video.load();
        } catch {
            // noop
        }

        const nativeHlsCanPlay = !!video.canPlayType("application/vnd.apple.mpegurl");
        const hlsJsSupported =
            typeof Hls !== "undefined" &&
            !!Hls &&
            typeof Hls.isSupported === "function" &&
            Hls.isSupported();

        console.log("[AkiraPlayer][HLS setup]", {
            src,
            nativeHlsCanPlay,
            hlsJsSupported,
            safariLikeNative: isSafariLikeForNativeHls(),
            hlsType: typeof Hls
        });

        if (hlsJsSupported) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true
            });

            hlsRef.current = hls;

            hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                console.log("[AkiraPlayer][HLS] MEDIA_ATTACHED");
            });

            hls.on(Hls.Events.MANIFEST_LOADING, (_evt, data) => {
                console.log("[AkiraPlayer][HLS] MANIFEST_LOADING", data);
            });

            hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
                console.log("[AkiraPlayer][HLS] MANIFEST_PARSED", {
                    levels: data?.levels?.length,
                    firstLevel: (data as any)?.firstLevel ?? null
                });
            });

            hls.on(Hls.Events.ERROR, (_evt, data) => {
                console.error("[AkiraPlayer][HLS] ERROR", {
                    type: data?.type,
                    details: data?.details,
                    fatal: data?.fatal,
                    response: data?.response
                        ? {
                            code: data.response.code,
                            text: data.response.text,
                            url: data.response.url
                        }
                        : null,
                    reason: (data as any)?.reason || null
                });
            });

            hls.loadSource(src);
            hls.attachMedia(video);
        } else if (nativeHlsCanPlay && isSafariLikeForNativeHls()) {
            console.log("[AkiraPlayer][HLS] usando HLS nativo (Safari/iOS)");
            video.src = src;
            video.load();
        } else {
            console.warn("[AkiraPlayer] HLS no soportado en este navegador", {
                nativeHlsCanPlay,
                hlsJsSupported,
                safariLikeNative: isSafariLikeForNativeHls()
            });
        }

        return () => {
            try {
                if (hlsRef.current) {
                    hlsRef.current.destroy();
                    hlsRef.current = null;
                }
            } catch {
                // noop
            }

            try {
                video.pause();
            } catch {
                // noop
            }

            try {
                video.removeAttribute("src");
                video.load();
            } catch {
                // noop
            }
        };
    }, [src]);

    // Video events
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;

        const onPlay = () => {
            setPlaying(true);
            showControlsTemporarily();
        };

        const onPause = () => {
            setPlaying(false);
            setControlsVisible(true);
        };

        const onTime = () => {
            setCurrentTime(v.currentTime || 0);

            try {
                if (v.buffered && v.buffered.length > 0) {
                    const end = v.buffered.end(v.buffered.length - 1);
                    setBufferedEnd(end);
                }
            } catch {
                // noop
            }
        };

        const onMeta = () => {
            setDuration(v.duration || 0);

            // ✅ autoplay inicial o forzado por playlist mode
            if (autoplay || playlistNextAutoplayRef.current) {
                v.play().catch(() => {
                    // noop
                });
                playlistNextAutoplayRef.current = false;
            }
        };

        const onVolume = () => {
            setMuted(v.muted);
            setVolume(v.volume);
        };

        const onEnded = () => {
            setPlaying(false);
            setControlsVisible(true);

            // ✅ Playlist mode: avanzar automáticamente al siguiente episodio
            if (
                playlistMode &&
                isSeriesContext &&
                nextEpisodeInPlaylist &&
                onSelectEpisode
            ) {
                playlistNextAutoplayRef.current = true;
                flashFeedback("Siguiente episodio");
                onSelectEpisode(nextEpisodeInPlaylist.id, nextEpisodeInPlaylist);
                return;
            }

            flashFeedback("Finalizado");
        };

        const onError = () => {
            const err = v.error;
            console.error("[AkiraPlayer][video] error", {
                currentSrc: v.currentSrc,
                networkState: v.networkState,
                readyState: v.readyState,
                mediaError: err ? { code: err.code, message: err.message || null } : null
            });
        };

        v.addEventListener("play", onPlay);
        v.addEventListener("pause", onPause);
        v.addEventListener("timeupdate", onTime);
        v.addEventListener("progress", onTime);
        v.addEventListener("loadedmetadata", onMeta);
        v.addEventListener("durationchange", onMeta);
        v.addEventListener("volumechange", onVolume);
        v.addEventListener("ended", onEnded);
        v.addEventListener("error", onError);

        v.volume = 1;

        if (autoplay) {
            v.play().catch(() => {
                // noop
            });
        }

        return () => {
            v.removeEventListener("play", onPlay);
            v.removeEventListener("pause", onPause);
            v.removeEventListener("timeupdate", onTime);
            v.removeEventListener("progress", onTime);
            v.removeEventListener("loadedmetadata", onMeta);
            v.removeEventListener("durationchange", onMeta);
            v.removeEventListener("volumechange", onVolume);
            v.removeEventListener("ended", onEnded);
            v.removeEventListener("error", onError);
        };
    }, [autoplay, playlistMode, isSeriesContext, nextEpisodeInPlaylist, onSelectEpisode]);

    // Fullscreen state
    useEffect(() => {
        const onFsChange = () => {
            setIsFullscreen(Boolean(document.fullscreenElement));
            showControlsTemporarily();
        };
        document.addEventListener("fullscreenchange", onFsChange);
        return () => document.removeEventListener("fullscreenchange", onFsChange);
    }, []);

    // Continue Watching (load episodio actual)
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        if (!duration || !Number.isFinite(duration)) return;
        if (restoredRef.current) return;

        // ✅ Evitar load genérico de progreso en contexto serie sin episodeId
        if (isSeriesContext && !episodeId) {
            restoredRef.current = true;
            return;
        }

        let cancelled = false;

        (async () => {
            const row = await loadProgress({
                contentId,
                seasonId: effectiveSeasonIdForCurrentEpisode,
                episodeId
            });

            if (cancelled || !row) {
                restoredRef.current = true;
                return;
            }

            // ✅ Si es serie, validar que el progreso devuelto sea del episodio actual
            if (isSeriesContext && episodeId) {
                if (
                    !isStrictEpisodeProgressRowMatch({
                        row,
                        contentId,
                        episodeId,
                        seasonId: effectiveSeasonIdForCurrentEpisode,
                        requireEpisodeId: true
                    })
                ) {
                    restoredRef.current = true;
                    return;
                }
            }

            const pos = Number((row as any).position_seconds || 0);
            const total = Number((row as any).duration_seconds || 0);
            const nearEnd = total > 0 && total - pos <= (CONFIG.NEAR_END_SECONDS ?? 45);

            if (nearEnd) {
                restoredRef.current = true;
                return;
            }

            if (pos > 0 && pos < Math.max(0, duration - 3)) {
                try {
                    v.currentTime = pos;
                    setCurrentTime(pos);
                    flashFeedback(`Continuar en ${fmtTime(pos)}`);
                } catch {
                    // noop
                }
            }

            restoredRef.current = true;
        })();

        return () => {
            cancelled = true;
        };
    }, [duration, contentId, effectiveSeasonIdForCurrentEpisode, episodeId, isSeriesContext]);

    // Continue Watching (throttled save)
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;

        const onTimeUpdateSave = () => {
            const now = Date.now();
            if (now - lastSavedAtRef.current < CONFIG.PROGRESS_THROTTLE_MS) return;
            lastSavedAtRef.current = now;

            const total = v.duration || 0;
            if (!Number.isFinite(total) || total <= 0) return;

            // ✅ Si es contexto serie pero no hay episodeId, no guardamos (evita contaminar progreso)
            if (isSeriesContext && !episodeId) return;

            void saveProgress({
                contentId,
                seasonId: effectiveSeasonIdForCurrentEpisode,
                episodeId,
                positionSeconds: v.currentTime || 0,
                durationSeconds: total
            });
        };

        v.addEventListener("timeupdate", onTimeUpdateSave);
        return () => v.removeEventListener("timeupdate", onTimeUpdateSave);
    }, [contentId, effectiveSeasonIdForCurrentEpisode, episodeId, isSeriesContext]);

    // Continue Watching (flush)
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;

        const flush = () => {
            const total = v.duration || 0;
            if (!Number.isFinite(total) || total <= 0) return;

            // ✅ Si es contexto serie pero no hay episodeId, no guardamos
            if (isSeriesContext && !episodeId) return;

            void saveProgress({
                contentId,
                seasonId: effectiveSeasonIdForCurrentEpisode,
                episodeId,
                positionSeconds: v.currentTime || 0,
                durationSeconds: total
            });
        };

        const onVisibilityChange = () => {
            if (document.visibilityState === "hidden") flush();
        };

        v.addEventListener("pause", flush);
        window.addEventListener("beforeunload", flush);
        document.addEventListener("visibilitychange", onVisibilityChange);

        return () => {
            v.removeEventListener("pause", flush);
            window.removeEventListener("beforeunload", flush);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, [contentId, effectiveSeasonIdForCurrentEpisode, episodeId, isSeriesContext]);

    // ✅ Fallback: si el modal ya está abierto y cambia la lista/temporada desde props, rehidratar
    useEffect(() => {
        if (!showEpisodes) return;
        void hydrateEpisodesModalData();
    }, [showEpisodes, hydrateEpisodesModalData]);

    // Thumbnails VTT (hover preview)
    useEffect(() => {
        let cancelled = false;

        if (!thumbnailsVtt) {
            setThumbnailCues([]);
            return;
        }

        (async () => {
            try {
                const cues = await loadThumbnailVtt(thumbnailsVtt);
                if (!cancelled) setThumbnailCues(cues);
            } catch (e) {
                console.warn("[AkiraPlayer] thumbnails VTT error:", e);
                if (!cancelled) setThumbnailCues([]);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [thumbnailsVtt]);

    // Keyboard shortcuts
    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;

        const onKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;

            const key = e.key.toLowerCase();

            if (key === " " || key === "k") {
                e.preventDefault();
                togglePlay();
                return;
            }

            if (key === "j" || key === "arrowleft") {
                e.preventDefault();
                seekBy(-10);
                return;
            }

            if (key === "l" || key === "arrowright") {
                e.preventDefault();
                seekBy(10);
                return;
            }

            if (key === "m") {
                e.preventDefault();
                toggleMute();
                return;
            }

            if (key === "f") {
                e.preventDefault();
                void toggleFullscreen();
                return;
            }

            if (key === "escape") {
                setShowSeasonDropdown(false);
                closeFloatingPanels();
                setControlsVisible(true);
            }
        };

        el.addEventListener("keydown", onKeyDown);
        return () => el.removeEventListener("keydown", onKeyDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Cerrar dropdown custom
    useEffect(() => {
        if (!showSeasonDropdown) return;

        const onPointerDown = (e: MouseEvent) => {
            const target = e.target as Node | null;
            if (!seasonDropdownRef.current?.contains(target)) {
                setShowSeasonDropdown(false);
            }
        };

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                setShowSeasonDropdown(false);
            }
        };

        document.addEventListener("mousedown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);

        return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [showSeasonDropdown]);

    // CSS var volume fill
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;

        const applyVolumeGradient = () => {
            const current = v.muted ? 0 : v.volume;
            const percent = Math.max(0, Math.min(100, current * 100));
            const value = `${percent}%`;

            wrapRef.current?.style.setProperty("--akira-volume-percent", value);
            volumeSliderRef.current?.style.setProperty("--akira-volume-percent", value);
        };

        applyVolumeGradient();
        v.addEventListener("volumechange", applyVolumeGradient);

        return () => {
            v.removeEventListener("volumechange", applyVolumeGradient);
        };
    }, []);

    // Cleanup timers
    useEffect(() => {
        return () => {
            if (controlsHideTimerRef.current) window.clearTimeout(controlsHideTimerRef.current);
            if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
        };
    }, []);

    // Derived
    const volumeIcon = useMemo(() => {
        // mute explícito
        if (muted) return ICONS.volume.mute;

        const pct = Math.round((volume || 0) * 100);

        // 0% -> mute
        if (pct <= 0) return ICONS.volume.mute;

        // 1% a 30% -> vol0
        if (pct <= 30) return ICONS.volume.vol0;

        // 31% a 74% -> vol1
        if (pct < 75) return ICONS.volume.vol1;

        // 75% a 100% -> vol2
        return ICONS.volume.vol2;
    }, [ICONS, muted, volume]);

    const progressPct = useMemo(() => {
        if (!duration || !Number.isFinite(duration)) return 0;
        return Math.max(0, Math.min(100, (currentTime / duration) * 100));
    }, [currentTime, duration]);

    const bufferedPct = useMemo(() => {
        if (!duration || !Number.isFinite(duration)) return 0;
        return Math.max(0, Math.min(100, (bufferedEnd / duration) * 100));
    }, [bufferedEnd, duration]);

    const hoverCue = useMemo(() => {
        if (hoverTime == null || !thumbnailCues.length) return null;
        return findThumbnailCue(thumbnailCues, hoverTime);
    }, [hoverTime, thumbnailCues]);

    // ✅ strict TS safe vars para preview
    const hoverCueSafe = hoverCue;
    const hoverCueXYWH = hoverCueSafe?.xywh ?? null;
    const hoverTimeSafe = hoverTime ?? 0;

    const hasEpisodes = episodes.length > 0;
    const hasRecommendations = recommendations.length > 0;

    const seasonDropdownOptions = useMemo(() => [1, 2], []);

    const episodesForSelectedSeason = useMemo(() => {
        return episodes.filter((ep) => {
            const epSeason = ep.seasonNumber ?? 1;
            return epSeason === selectedSeasonNumber;
        });
    }, [episodes, selectedSeasonNumber]);

    // Controls actions
    const togglePlay = () => {
        const v = videoRef.current;
        if (!v) return;

        showControlsTemporarily();

        if (v.paused) {
            v.play().catch(() => { /* noop */ });
            flashFeedback("Play");
        } else {
            v.pause();
            flashFeedback("Pause");
        }
    };

    const seekBy = (delta: number) => {
        const v = videoRef.current;
        if (!v) return;

        const max = Number.isFinite(v.duration) ? v.duration : Infinity;
        v.currentTime = Math.max(0, Math.min(max, (v.currentTime || 0) + delta));
        flashFeedback(delta > 0 ? `+${delta}s` : `${delta}s`);
        showControlsTemporarily();
    };

    const onSeekBarChange = (value: number) => {
        const v = videoRef.current;
        if (!v) return;
        v.currentTime = value;
        setCurrentTime(value);
        showControlsTemporarily();
    };

    const onProgressMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        const el = progressWrapRef.current;
        if (!el || !duration) return;

        const rect = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
        const ratio = rect.width ? x / rect.width : 0;
        const t = ratio * duration;

        setHoverX(x);
        setHoverTime(t);
        setShowThumbPreview(true);
    };

    const onProgressMouseLeave = () => {
        setShowThumbPreview(false);
        setHoverTime(null);
    };

    const toggleMute = () => {
        const v = videoRef.current;
        if (!v) return;
        v.muted = !v.muted;
        flashFeedback(v.muted ? "Mute" : "Unmute");
        showControlsTemporarily();
    };

    const onVolumeInput = (value: number) => {
        const v = videoRef.current;
        if (!v) return;

        const safeValue = clamp(value, 0, 1);

        v.volume = safeValue;

        // ✅ Consistencia: slider en 0 => mute real
        v.muted = safeValue <= 0;

        flashFeedback(`Vol ${Math.round(safeValue * 100)}%`);
        showControlsTemporarily();
    };

    const toggleFullscreen = async () => {
        const el = wrapRef.current;
        if (!el) return;

        try {
            if (!document.fullscreenElement) {
                await el.requestFullscreen();
                flashFeedback("Pantalla completa");
            } else {
                await document.exitFullscreen();
                flashFeedback("Salir pantalla completa");
            }
        } catch {
            // noop
        }
    };

    const openRecommendationsPanel = () => {
        closeFloatingPanels();

        if (onOpenRecommendations) {
            onOpenRecommendations();
            return;
        }

        setShowRecommendations(true);
        showControlsTemporarily();
    };

    const openEpisodesPanel = async () => {
        closeFloatingPanels();

        const currentEpisode = episodeId ? episodes.find((ep) => ep.id === episodeId) : null;
        const nextSeason = currentEpisode?.seasonNumber === 2 ? 2 : 1;
        setSelectedSeasonNumber(nextSeason);
        setShowSeasonDropdown(false);

        // ✅ Primero hidrata data del modal (progreso + thumbs), después abre
        try {
            await hydrateEpisodesModalData();
        } catch {
            // noop
        }

        setShowEpisodes(true);
        showControlsTemporarily();
    };

    const handleEpisodeClick = (ep: EpisodeItem) => {
        if (onSelectEpisode) onSelectEpisode(ep.id, ep);
        setShowSeasonDropdown(false);
        setShowEpisodes(false);
        showControlsTemporarily();
    };

    const handleRecommendationClick = (item: RecommendedItem) => {
        if (onSelectRecommendation) onSelectRecommendation(item);
        setShowRecommendations(false);
        showControlsTemporarily();
    };

    const handlePointerMove = () => {
        setIsPointerOverPlayer(true);
        showControlsTemporarily();
    };

    const handlePointerLeave = () => {
        setIsPointerOverPlayer(false);
        if (playing) {
            if (controlsHideTimerRef.current) window.clearTimeout(controlsHideTimerRef.current);
            controlsHideTimerRef.current = window.setTimeout(() => {
                if (!anyFloatingOpen) {
                    setControlsVisible(false);
                }
            }, 900);
        }
    };

    const handleDoubleClickOverlay = (side: "left" | "right") => {
        if (side === "left") seekBy(-10);
        else seekBy(10);
    };

    return (
        <div
            className={`akira-wrap ${controlsVisible ? "controls-visible" : "controls-hidden"}`}
            ref={wrapRef}
            tabIndex={0}
            role="application"
            aria-label="AkiraPlayer"
            onMouseMove={handlePointerMove}
            onMouseLeave={handlePointerLeave}
            onClick={() => {
                if (showSeasonDropdown) setShowSeasonDropdown(false);
                showControlsTemporarily();
            }}
            onContextMenu={(e) => e.preventDefault()}
        >
            {/* VIDEO */}
            <video
                ref={videoRef}
                className="akira-video"
                poster={poster}
                playsInline
                controls={false}
                preload="metadata"
                crossOrigin="anonymous"
            >
                {subtitles.map((t) => (
                    <track
                        key={`${t.srclang}-${t.label}`}
                        kind="subtitles"
                        src={t.src}
                        srcLang={t.srclang}
                        label={t.label}
                        default={t.default}
                    />
                ))}
            </video>

            {/* DOUBLE CLICK SEEK ZONES */}
            <div className="akira-gesture-layer" aria-hidden="true">
                <button
                    type="button"
                    className="akira-gesture-zone left"
                    onDoubleClick={() => handleDoubleClickOverlay("left")}
                    onClick={(e) => e.stopPropagation()}
                    tabIndex={-1}
                />
                <button
                    type="button"
                    className="akira-gesture-zone center"
                    onDoubleClick={(e) => e.preventDefault()}
                    onClick={(e) => {
                        e.stopPropagation();
                        togglePlay();
                    }}
                    tabIndex={-1}
                />
                <button
                    type="button"
                    className="akira-gesture-zone right"
                    onDoubleClick={() => handleDoubleClickOverlay("right")}
                    onClick={(e) => e.stopPropagation()}
                    tabIndex={-1}
                />
            </div>

            {/* TOP OVERLAY */}
            <div className="akira-top-overlay">
                <div
                    className="akira-top-left"
                    style={{ display: "grid", gap: 10, alignContent: "start" }}
                >
                    <button
                        type="button"
                        className="akira-ghost-btn akira-back-btn"
                        onClick={(e) => {
                            e.stopPropagation();
                            goBackToOpenedTitle();
                        }}
                        aria-label="Volver"
                        title="Volver"
                    >
                        ←
                    </button>

                    {/* Meta debajo del back button (sin prefijo "Pelicula"/"Serie") */}
                    <div className="akira-top-meta" aria-live="polite">
                        <div className="akira-title">{displayContentTitle}</div>

                        {isSeriesContext && topMetaEpisodeLine ? (
                            <div
                                className="akira-channel"
                                style={{
                                    textTransform: "none",
                                    letterSpacing: "normal",
                                    opacity: 0.95,
                                    marginTop: 6,
                                    fontWeight: 600
                                }}
                            >
                                {topMetaEpisodeLine}
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>

            {/* CENTER FEEDBACK */}
            <div className={`akira-feedback ${feedback?.visible ? "show" : ""}`} aria-hidden="true">
                <div className="akira-feedback-pill">{feedback?.text ?? ""}</div>
            </div>

            {/* Backdrop paneles */}
            {(showEpisodes || showRecommendations) && (
                <div
                    className="akira-overlay-shell"
                    aria-hidden="true"
                    onClick={(e) => {
                        e.stopPropagation();
                        closeFloatingPanels();
                        showControlsTemporarily();
                    }}
                />
            )}

            {/* Modal Episodios */}
            {showEpisodes && (
                <div
                    className="akira-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Episodios"
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="akira-modal-header">
                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 12,
                                minWidth: 0,
                                flexWrap: "wrap"
                            }}
                        >
                            <div className="akira-modal-title">
                                {displayContentTitle} · Listado de episodios
                            </div>

                            {/* Dropdown custom temporada */}
                            <div className="akira-season-dd" ref={seasonDropdownRef}>
                                <button
                                    type="button"
                                    className={`akira-season-dd-trigger ${showSeasonDropdown ? "open" : ""}`}
                                    aria-haspopup="menu"
                                    aria-expanded={showSeasonDropdown}
                                    aria-label={`Temporada seleccionada: ${selectedSeasonNumber}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setShowSeasonDropdown((v) => !v);
                                        showControlsTemporarily();
                                    }}
                                >
                                    <span>Temporada {selectedSeasonNumber}</span>
                                    <span className="akira-season-dd-caret" aria-hidden="true">
                                        ▾
                                    </span>
                                </button>

                                {showSeasonDropdown && (
                                    <div
                                        className="akira-season-dd-menu"
                                        role="menu"
                                        aria-label="Seleccionar temporada"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {seasonDropdownOptions.map((s) => {
                                            const active = s === selectedSeasonNumber;

                                            return (
                                                <button
                                                    key={s}
                                                    type="button"
                                                    role="menuitemradio"
                                                    aria-checked={active}
                                                    className={`akira-season-dd-item ${active ? "active" : ""}`}
                                                    onClick={() => {
                                                        setSelectedSeasonNumber(s);
                                                        setShowSeasonDropdown(false);
                                                        showControlsTemporarily();
                                                    }}
                                                >
                                                    <span className="akira-season-dd-item-text">Temporada {s}</span>
                                                    {active && (
                                                        <span className="akira-season-dd-check" aria-hidden="true" />
                                                    )}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>

                        <button
                            type="button"
                            className="akira-modal-close"
                            onClick={() => {
                                setShowSeasonDropdown(false);
                                setShowEpisodes(false);
                                showControlsTemporarily();
                            }}
                            aria-label="Cerrar"
                            title="Cerrar"
                        >
                            ✕
                        </button>
                    </div>

                    <div className="akira-modal-body">
                        {isEpisodesModalPreparing ? (
                            <div className="akira-empty-state">
                                Cargando episodios...
                            </div>
                        ) : episodes.length === 0 ? (
                            <div className="akira-empty-state">
                                No hay episodios cargados todavía.
                            </div>
                        ) : episodesForSelectedSeason.length === 0 ? (
                            <div className="akira-empty-state">
                                No hay episodios cargados para la temporada {selectedSeasonNumber}.
                            </div>
                        ) : (
                            <div className="akira-episode-list">
                                {episodesForSelectedSeason.map((ep) => {
                                    const isCurrent = !!episodeId && ep.id === episodeId;

                                    const epLabel =
                                        ep.seasonNumber != null && ep.episodeNumber != null
                                            ? `T${ep.seasonNumber} · E${ep.episodeNumber}`
                                            : ep.episodeNumber != null
                                                ? `E${ep.episodeNumber}`
                                                : "Episodio";

                                    const episodeThumb = getEpisodeThumbSrc(ep, episodeThumbsMap[ep.id]);

                                    const epProgress = episodeProgressMap[ep.id];
                                    const showEpisodeProgress = !!epProgress?.hasProgress;

                                    return (
                                        <button
                                            key={ep.id}
                                            type="button"
                                            className={`akira-episode-card ${isCurrent ? "current" : ""}`}
                                            onClick={() => handleEpisodeClick(ep)}
                                            title={ep.title}
                                        >
                                            <div className="akira-episode-thumb">
                                                {episodeThumb ? (
                                                    <img
                                                        src={episodeThumb}
                                                        alt=""
                                                        loading="lazy"
                                                        onError={(e) => {
                                                            const img = e.currentTarget;
                                                            console.warn("[AkiraPlayer] Thumb episodio falló:", {
                                                                episodeId: ep.id,
                                                                src: img.currentSrc || img.src
                                                            });
                                                        }}
                                                    />
                                                ) : (
                                                    <div className="akira-thumb-empty" />
                                                )}

                                                <span className="akira-episode-badge">{epLabel}</span>

                                                {showEpisodeProgress && epProgress && (
                                                    <div
                                                        className="akira-episode-thumb-progress"
                                                        aria-label={
                                                            epProgress.completed
                                                                ? "Episodio visto"
                                                                : `Progreso ${Math.round(epProgress.percent)}%`
                                                        }
                                                        title={
                                                            epProgress.durationSeconds > 0
                                                                ? `${fmtTime(epProgress.positionSeconds)} / ${fmtTime(epProgress.durationSeconds)}`
                                                                : `${Math.round(epProgress.percent)}%`
                                                        }
                                                    >
                                                        <div
                                                            className="akira-episode-thumb-progress-fill"
                                                            style={{ width: `${epProgress.percent}%` }}
                                                        />
                                                    </div>
                                                )}
                                            </div>

                                            <div className="akira-episode-info">
                                                <div className="akira-episode-title-row">
                                                    <div className="akira-episode-title">{ep.title}</div>
                                                    {isCurrent && (
                                                        <span className="akira-episode-current-pill">
                                                            Reproduciendo
                                                        </span>
                                                    )}
                                                </div>

                                                {ep.synopsis && (
                                                    <div className="akira-episode-synopsis">
                                                        {ep.synopsis}
                                                    </div>
                                                )}

                                                <div
                                                    style={{
                                                        display: "flex",
                                                        alignItems: "center",
                                                        gap: 10,
                                                        flexWrap: "wrap"
                                                    }}
                                                >
                                                    {ep.durationSeconds != null && ep.durationSeconds > 0 && (
                                                        <div className="akira-episode-meta">
                                                            {fmtTime(ep.durationSeconds)}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Panel recomendado */}
            {showRecommendations && !onOpenRecommendations && (
                <div
                    className="akira-modal akira-modal-reco"
                    role="dialog"
                    aria-modal="true"
                    aria-label={recommendationsLabel}
                    onClick={(e) => e.stopPropagation()}
                >
                    <div className="akira-modal-header">
                        <div className="akira-modal-title">{recommendationsLabel}</div>
                        <button
                            type="button"
                            className="akira-modal-close"
                            onClick={() => {
                                setShowRecommendations(false);
                                showControlsTemporarily();
                            }}
                            aria-label="Cerrar"
                            title="Cerrar"
                        >
                            ✕
                        </button>
                    </div>

                    <div className="akira-modal-body">
                        {!hasRecommendations ? (
                            <div className="akira-empty-state">
                                No hay recomendaciones disponibles todavía.
                            </div>
                        ) : (
                            <div className="akira-reco-grid">
                                {recommendations.map((item) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        className="akira-reco-card"
                                        onClick={() => handleRecommendationClick(item)}
                                        title={item.title}
                                    >
                                        <div className="akira-reco-poster">
                                            {item.poster ? (
                                                <img src={item.poster} alt="" loading="lazy" />
                                            ) : (
                                                <div className="akira-thumb-empty" />
                                            )}
                                            {item.type && (
                                                <span className="akira-reco-type">
                                                    {item.type === "series"
                                                        ? "Serie"
                                                        : item.type === "movie"
                                                            ? "Película"
                                                            : item.type}
                                                </span>
                                            )}
                                        </div>

                                        <div className="akira-reco-title">{item.title}</div>

                                        {item.synopsis ? (
                                            <div className="akira-reco-synopsis">{item.synopsis}</div>
                                        ) : null}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* BOTTOM CONTROLS */}
            <div
                className="akira-controls"
                onMouseEnter={() => setControlsVisible(true)}
                onMouseLeave={() => {
                    if (playing) showControlsTemporarily();
                }}
            >
                <div className="akira-progress-row">
                    <span className="akira-time">{fmtTime(currentTime)}</span>

                    <div
                        className="akira-progress-wrap"
                        ref={progressWrapRef}
                        onMouseMove={onProgressMouseMove}
                        onMouseLeave={onProgressMouseLeave}
                    >
                        <div className="akira-progress-visual" aria-hidden="true">
                            <div className="akira-progress-track" />
                            <div className="akira-progress-buffered" style={{ width: `${bufferedPct}%` }} />
                            <div className="akira-progress-played" style={{ width: `${progressPct}%` }} />
                        </div>

                        <input
                            className="akira-progress"
                            type="range"
                            min={0}
                            max={duration || 0}
                            step={0.1}
                            value={Math.min(currentTime, duration || 0)}
                            onChange={(e) => onSeekBarChange(Number(e.target.value))}
                            onInput={(e) => onSeekBarChange(Number((e.target as HTMLInputElement).value))}
                            aria-label="Progreso"
                        />

                        {showThumbPreview && hoverTime != null && (
                            <div className="akira-thumb-preview" style={{ left: hoverX }}>
                                <div className="akira-thumb-image">
                                    {hoverCueSafe ? (
                                        hoverCueXYWH ? (
                                            <div
                                                className="akira-thumb-sprite"
                                                style={{
                                                    backgroundImage: `url(${hoverCueSafe.url})`,
                                                    backgroundPosition: `-${hoverCueXYWH.x}px -${hoverCueXYWH.y}px`,
                                                    width: `${hoverCueXYWH.w}px`,
                                                    height: `${hoverCueXYWH.h}px`
                                                }}
                                            />
                                        ) : (
                                            <img src={hoverCueSafe.url} alt="" />
                                        )
                                    ) : (
                                        <div className="akira-thumb-empty" />
                                    )}
                                </div>
                                <div className="akira-thumb-time">{fmtTime(hoverTimeSafe)}</div>
                            </div>
                        )}
                    </div>

                    <span className="akira-time">{fmtTime(duration)}</span>
                </div>

                <div className="akira-toolbar">
                    <div className="akira-left">
                        <button
                            type="button"
                            className="akira-text-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                openRecommendationsPanel();
                            }}
                            title={recommendationsLabel}
                            aria-label={recommendationsLabel}
                        >
                            {recommendationsLabel}
                            {hasRecommendations ? (
                                <span className="akira-text-btn-count">{recommendations.length}</span>
                            ) : null}
                        </button>

                        <button
                            type="button"
                            className="akira-text-btn"
                            onClick={(e) => {
                                e.stopPropagation();
                                void openEpisodesPanel();
                            }}
                            title="Episodios"
                            aria-label="Episodios"
                            disabled={!hasEpisodes || isEpisodesModalPreparing}
                        >
                            {isEpisodesModalPreparing ? "Cargando..." : "Episodios"}
                            {hasEpisodes ? (
                                <span className="akira-text-btn-count">{episodes.length}</span>
                            ) : null}
                        </button>
                    </div>

                    <div className="akira-center-cluster">
                        <IconButton
                            onClick={() => seekBy(-10)}
                            icon={ICONS.backward}
                            label="Retroceder 10s"
                            size="xl"
                        />

                        <IconButton
                            onClick={togglePlay}
                            icon={playing ? ICONS.pause : ICONS.play}
                            label={playing ? "Pause" : "Play"}
                            size="xxl"
                            emphasized
                            className="playPauseBtn"
                            imgClassName={!playing ? "playSVG" : ""}
                        />

                        <IconButton
                            onClick={() => seekBy(10)}
                            icon={ICONS.forward}
                            label="Adelantar 10s"
                            size="xl"
                        />
                    </div>

                    <div className="akira-right">
                        <div
                            className="akira-volume"
                            onMouseEnter={() => {
                                setShowVolumeSlider(true);
                                showControlsTemporarily();
                            }}
                            onMouseLeave={() => setShowVolumeSlider(false)}
                        >
                            <IconButton
                                onClick={toggleMute}
                                icon={volumeIcon}
                                label={muted ? "Unmute" : "Mute"}
                                size="lg"
                            />

                            <div className={`akira-volume-pop ${showVolumeSlider ? "show" : ""}`}>
                                <input
                                    ref={volumeSliderRef}
                                    className="akira-volume-slider"
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={muted ? 0 : volume}
                                    onInput={(e) => onVolumeInput(Number((e.target as HTMLInputElement).value))}
                                    onChange={(e) => onVolumeInput(Number(e.target.value))}
                                    aria-label="Volumen"
                                />
                            </div>
                        </div>

                        <IconButton
                            onClick={() => void toggleFullscreen()}
                            icon={isFullscreen ? ICONS.windowed : ICONS.fullscreen}
                            label={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
                            size="lg"
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}

type IconButtonProps = {
    onClick: () => void;
    icon: string;
    label: string;
    size?: "lg" | "xl" | "xxl";
    emphasized?: boolean;
    disabled?: boolean;
    className?: string;
    imgClassName?: string;
};

function IconButton({
    onClick,
    icon,
    label,
    size = "lg",
    emphasized = false,
    disabled = false,
    className = "",
    imgClassName = ""
}: IconButtonProps) {
    return (
        <button
            type="button"
            className={`akira-icon-btn ${size} ${emphasized ? "emphasized" : ""} ${className}`.trim()}
            onClick={onClick}
            aria-label={label}
            title={label}
            disabled={disabled}
        >
            <img src={icon} alt="" className={imgClassName} />
        </button>
    );
}