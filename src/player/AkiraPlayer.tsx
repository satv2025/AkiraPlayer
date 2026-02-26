// AkiraPlayer.tsx
import Hls from "hls.js";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { SubtitleTrackInput } from "../index";
import { CONFIG } from "../config";
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
    thumbnail?: string | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    durationSeconds?: number | null;
};

type Props = {
    src: string;
    poster?: string;
    autoplay?: boolean;
    title?: string; // compatibilidad
    channelLabel?: string; // compatibilidad

    /** Base de assets (compat actual) */
    assetBase?: string;

    /** Alias opcional para usar desde embeds/watch.html */
    assetBaseUrl?: string;

    contentId: string;
    seasonId?: string | null;
    episodeId?: string | null;

    thumbnailsVtt?: string;
    subtitles?: SubtitleTrackInput[];

    onBack?: () => void;

    // Left actions / data
    recommendations?: RecommendedItem[];
    episodes?: EpisodeItem[];

    onOpenRecommendations?: () => void;
    onSelectRecommendation?: (item: RecommendedItem) => void;
    onSelectEpisode?: (episodeId: string, episode?: EpisodeItem) => void;

    recommendationsLabel?: string;
};

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

type FeedbackState = { text: string; visible: boolean } | null;

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
    recommendationsLabel = "Te podría gustar"
}: Props) {
    // Compat TS estricto (no se muestran)
    void title;
    void channelLabel;

    // ✅ Prioridad: assetBaseUrl > assetBase > "/assets"
    const resolvedAssetBase = (assetBaseUrl || assetBase || "/assets").replace(/\/$/, "");

    const ICONS = useMemo(() => getIcons(resolvedAssetBase), [resolvedAssetBase]);

    const wrapRef = useRef<HTMLDivElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const progressWrapRef = useRef<HTMLDivElement | null>(null);
    const volumeSliderRef = useRef<HTMLInputElement | null>(null);

    const hlsRef = useRef<Hls | null>(null);
    const restoredRef = useRef(false);
    const lastSavedAtRef = useRef(0);
    const controlsHideTimerRef = useRef<number | null>(null);
    const feedbackTimerRef = useRef<number | null>(null);

    // Playback / UI state
    const [playing, setPlaying] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [muted, setMuted] = useState(false);
    const [volume, setVolume] = useState(1);

    const [showVolumeSlider, setShowVolumeSlider] = useState(false);

    // Layout left panels
    const [showEpisodes, setShowEpisodes] = useState(false);
    const [showRecommendations, setShowRecommendations] = useState(false);

    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [bufferedEnd, setBufferedEnd] = useState(0);

    // Controls visibility / OTT vibe
    const [controlsVisible, setControlsVisible] = useState(true);
    const [isPointerOverPlayer, setIsPointerOverPlayer] = useState(false);

    // Feedback overlay (+10s / -10s / Play / Pause)
    const [feedback, setFeedback] = useState<FeedbackState>(null);

    // Thumbnail hover preview (VTT)
    const [thumbnailCues, setThumbnailCues] = useState<ThumbnailCue[]>([]);
    const [hoverTime, setHoverTime] = useState<number | null>(null);
    const [hoverX, setHoverX] = useState(0);
    const [showThumbPreview, setShowThumbPreview] = useState(false);

    const anyFloatingOpen = showEpisodes || showRecommendations || showVolumeSlider;

    // ----------------------------
    // Helpers
    // ----------------------------
    const showControlsTemporarily = () => {
        setControlsVisible(true);

        if (controlsHideTimerRef.current) {
            window.clearTimeout(controlsHideTimerRef.current);
            controlsHideTimerRef.current = null;
        }

        // Si está pausado, no ocultar
        if (!playing) return;

        controlsHideTimerRef.current = window.setTimeout(() => {
            if (!isPointerOverPlayer && !showEpisodes && !showVolumeSlider && !showRecommendations) {
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
    };

    // ----------------------------
    // HLS setup (.m3u8)
    // ----------------------------
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !src) return;

        restoredRef.current = false;

        if (hlsRef.current) {
            hlsRef.current.destroy();
            hlsRef.current = null;
        }

        // Safari / iOS con HLS nativo
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = src;
        } else if (Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true
            });

            hls.on(Hls.Events.ERROR, (_evt, data) => {
                console.warn("[AkiraPlayer][HLS] error:", data);
            });

            hls.loadSource(src);
            hls.attachMedia(video);
            hlsRef.current = hls;
        } else {
            console.warn("[AkiraPlayer] HLS no soportado en este navegador");
        }

        return () => {
            if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
            }
            video.removeAttribute("src");
        };
    }, [src]);

    // ----------------------------
    // Video events base
    // ----------------------------
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

        const onMeta = () => setDuration(v.duration || 0);

        const onVolume = () => {
            setMuted(v.muted);
            setVolume(v.volume);
        };

        const onEnded = () => {
            setPlaying(false);
            setControlsVisible(true);
            flashFeedback("Finalizado");
        };

        v.addEventListener("play", onPlay);
        v.addEventListener("pause", onPause);
        v.addEventListener("timeupdate", onTime);
        v.addEventListener("progress", onTime);
        v.addEventListener("loadedmetadata", onMeta);
        v.addEventListener("durationchange", onMeta);
        v.addEventListener("volumechange", onVolume);
        v.addEventListener("ended", onEnded);

        v.volume = 1;

        if (autoplay) {
            v.play().catch(() => {
                // autoplay puede bloquearse por navegador
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
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoplay]);

    // ----------------------------
    // Fullscreen state
    // ----------------------------
    useEffect(() => {
        const onFsChange = () => {
            setIsFullscreen(Boolean(document.fullscreenElement));
            showControlsTemporarily();
        };
        document.addEventListener("fullscreenchange", onFsChange);
        return () => document.removeEventListener("fullscreenchange", onFsChange);
    }, []);

    // ----------------------------
    // Continue Watching (load)
    // ----------------------------
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;
        if (!duration || !Number.isFinite(duration)) return;
        if (restoredRef.current) return;

        let cancelled = false;

        (async () => {
            const row = await loadProgress({ contentId, seasonId, episodeId });
            if (cancelled || !row) {
                restoredRef.current = true;
                return;
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
    }, [duration, contentId, seasonId, episodeId]);

    // ----------------------------
    // Continue Watching (throttled save)
    // ----------------------------
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;

        const onTimeUpdateSave = () => {
            const now = Date.now();
            if (now - lastSavedAtRef.current < CONFIG.PROGRESS_THROTTLE_MS) return;
            lastSavedAtRef.current = now;

            const total = v.duration || 0;
            if (!Number.isFinite(total) || total <= 0) return;

            void saveProgress({
                contentId,
                seasonId,
                episodeId,
                positionSeconds: v.currentTime || 0,
                durationSeconds: total
            });
        };

        v.addEventListener("timeupdate", onTimeUpdateSave);
        return () => v.removeEventListener("timeupdate", onTimeUpdateSave);
    }, [contentId, seasonId, episodeId]);

    // ----------------------------
    // Continue Watching (flush on pause / unload)
    // ----------------------------
    useEffect(() => {
        const v = videoRef.current;
        if (!v) return;

        const flush = () => {
            const total = v.duration || 0;
            if (!Number.isFinite(total) || total <= 0) return;

            void saveProgress({
                contentId,
                seasonId,
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
    }, [contentId, seasonId, episodeId]);

    // ----------------------------
    // Thumbnails VTT (hover preview)
    // ----------------------------
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

    // ----------------------------
    // Keyboard shortcuts
    // ----------------------------
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
                closeFloatingPanels();
                setControlsVisible(true);
            }
        };

        el.addEventListener("keydown", onKeyDown);
        return () => el.removeEventListener("keydown", onKeyDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ----------------------------
    // CSS var volume fill (WebKit dynamic gradient)
    // ----------------------------
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

    // ----------------------------
    // Cleanup timers
    // ----------------------------
    useEffect(() => {
        return () => {
            if (controlsHideTimerRef.current) window.clearTimeout(controlsHideTimerRef.current);
            if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
        };
    }, []);

    // ----------------------------
    // Derived values
    // ----------------------------
    const volumeIcon = useMemo(() => {
        if (muted) return ICONS.volume.mute;
        if (volume === 0) return ICONS.volume.vol0;
        if (volume <= 0.5) return ICONS.volume.vol1;
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

    const hasEpisodes = episodes.length > 0;
    const hasRecommendations = recommendations.length > 0;

    // ----------------------------
    // Controls actions
    // ----------------------------
    const togglePlay = () => {
        const v = videoRef.current;
        if (!v) return;

        showControlsTemporarily();

        if (v.paused) {
            v.play().catch(() => { });
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

        v.volume = value;
        if (value > 0 && v.muted) v.muted = false;

        flashFeedback(`Vol ${Math.round(value * 100)}%`);
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

    const openEpisodesPanel = () => {
        closeFloatingPanels();
        setShowEpisodes(true);
        showControlsTemporarily();
    };

    const handleEpisodeClick = (ep: EpisodeItem) => {
        if (onSelectEpisode) onSelectEpisode(ep.id, ep);
        setShowEpisodes(false);
        showControlsTemporarily();
    };

    const handleRecommendationClick = (item: RecommendedItem) => {
        if (onSelectRecommendation) onSelectRecommendation(item);
        setShowRecommendations(false);
        showControlsTemporarily();
    };

    // ----------------------------
    // Pointer / autohide controls
    // ----------------------------
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

    // Doble click seek
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
            onClick={showControlsTemporarily}
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

            {/* TOP OVERLAY (solo botón back) */}
            <div className="akira-top-overlay">
                <div className="akira-top-left">
                    <button
                        type="button"
                        className="akira-ghost-btn akira-back-btn"
                        onClick={(e) => {
                            e.stopPropagation();
                            if (onBack) onBack();
                            else window.history.back();
                        }}
                        aria-label="Volver"
                        title="Volver"
                    >
                        ←
                    </button>
                </div>
            </div>

            {/* CENTER FEEDBACK */}
            <div className={`akira-feedback ${feedback?.visible ? "show" : ""}`} aria-hidden="true">
                <div className="akira-feedback-pill">{feedback?.text ?? ""}</div>
            </div>

            {/* Backdrop para modales/paneles */}
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
                        <div className="akira-modal-title">
                            Episodios {episodes.length ? `(${episodes.length})` : ""}
                        </div>

                        <button
                            type="button"
                            className="akira-modal-close"
                            onClick={() => {
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
                        {episodes.length === 0 ? (
                            <div className="akira-empty-state">
                                No hay episodios cargados todavía.
                            </div>
                        ) : (
                            <div className="akira-episode-list">
                                {episodes.map((ep) => {
                                    const isCurrent = !!episodeId && ep.id === episodeId;
                                    const epLabel =
                                        ep.seasonNumber != null && ep.episodeNumber != null
                                            ? `T${String(ep.seasonNumber).padStart(2, "0")} · E${String(ep.episodeNumber).padStart(2, "0")}`
                                            : ep.episodeNumber != null
                                                ? `E${String(ep.episodeNumber).padStart(2, "0")}`
                                                : "Episodio";

                                    return (
                                        <button
                                            key={ep.id}
                                            type="button"
                                            className={`akira-episode-card ${isCurrent ? "current" : ""}`}
                                            onClick={() => handleEpisodeClick(ep)}
                                            title={ep.title}
                                        >
                                            <div className="akira-episode-thumb">
                                                {ep.thumbnail ? (
                                                    <img src={ep.thumbnail} alt="" loading="lazy" />
                                                ) : (
                                                    <div className="akira-thumb-empty" />
                                                )}
                                                <span className="akira-episode-badge">{epLabel}</span>
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

                                                {ep.durationSeconds != null && ep.durationSeconds > 0 && (
                                                    <div className="akira-episode-meta">
                                                        {fmtTime(ep.durationSeconds)}
                                                    </div>
                                                )}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* Panel recomendado interno (opcional, si no usás callback externo) */}
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
                {/* Progress / scrubber */}
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
                                    {hoverCue ? (
                                        hoverCue.xywh ? (
                                            <div
                                                className="akira-thumb-sprite"
                                                style={{
                                                    backgroundImage: `url(${hoverCue.url})`,
                                                    backgroundPosition: `-${hoverCue.xywh.x}px -${hoverCue.xywh.y}px`,
                                                    width: `${hoverCue.xywh.w}px`,
                                                    height: `${hoverCue.xywh.h}px`
                                                }}
                                            />
                                        ) : (
                                            <img src={hoverCue.url} alt="" />
                                        )
                                    ) : (
                                        <div className="akira-thumb-empty" />
                                    )}
                                </div>
                                <div className="akira-thumb-time">{fmtTime(hoverTime)}</div>
                            </div>
                        )}
                    </div>

                    <span className="akira-time">{fmtTime(duration)}</span>
                </div>

                {/* Toolbar LEFT / CENTER / RIGHT */}
                <div className="akira-toolbar">
                    {/* LEFT: Te podría gustar / Episodios (texto) */}
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
                                openEpisodesPanel();
                            }}
                            title="Episodios"
                            aria-label="Episodios"
                            disabled={!hasEpisodes}
                        >
                            Episodios
                            {hasEpisodes ? (
                                <span className="akira-text-btn-count">{episodes.length}</span>
                            ) : null}
                        </button>
                    </div>

                    {/* CENTER */}
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

                    {/* RIGHT: Volume / Fullscreen */}
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