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

type Props = {
    src: string;
    poster?: string;
    autoplay?: boolean;
    title?: string;
    channelLabel?: string;
    assetBase?: string;
    contentId: string;
    seasonId?: string | null;
    episodeId?: string | null;
    thumbnailsVtt?: string;
    subtitles?: SubtitleTrackInput[]; // se mantiene por compatibilidad, pero no mostramos botón CC
    onBack?: () => void;
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
    const base = `${assetBase.replace(/\/$/, "")}/media/icons/svg`;
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
    channelLabel = "SATV+",
    assetBase = "/assets",
    contentId,
    seasonId,
    episodeId,
    thumbnailsVtt,
    subtitles = [], // no UI de CC, pero dejamos tracks por compatibilidad futura
    onBack
}: Props) {
    const ICONS = useMemo(() => getIcons(assetBase), [assetBase]);

    const wrapRef = useRef<HTMLDivElement | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const progressWrapRef = useRef<HTMLDivElement | null>(null);

    const hlsRef = useRef<Hls | null>(null);
    const restoredRef = useRef(false);
    const lastSavedAtRef = useRef(0);
    const controlsHideTimerRef = useRef<number | null>(null);

    // Playback / UI state
    const [playing, setPlaying] = useState(false);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [muted, setMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [showVolumeSlider, setShowVolumeSlider] = useState(false);
    const [showEpisodes, setShowEpisodes] = useState(false);

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
            if (!isPointerOverPlayer && !showEpisodes && !showVolumeSlider) {
                setControlsVisible(false);
            }
        }, 2200);
    };

    const flashFeedback = (text: string) => {
        setFeedback({ text, visible: true });
        window.setTimeout(() => {
            setFeedback((prev) => (prev ? { ...prev, visible: false } : prev));
        }, 700);
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
    }, [autoplay, playing, isPointerOverPlayer, showEpisodes, showVolumeSlider]);

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
            if (cancelled || !row) return;

            const pos = Number(row.position_seconds || 0);
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

        v.addEventListener("pause", flush);
        window.addEventListener("beforeunload", flush);

        return () => {
            v.removeEventListener("pause", flush);
            window.removeEventListener("beforeunload", flush);
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
    // Keyboard shortcuts (sin speed / sin cc)
    // ----------------------------
    useEffect(() => {
        const el = wrapRef.current;
        if (!el) return;

        const onKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName?.toLowerCase();
            if (tag === "input" || tag === "textarea") return;

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
            }
        };

        el.addEventListener("keydown", onKeyDown);
        return () => el.removeEventListener("keydown", onKeyDown);
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
                if (!showEpisodes && !showVolumeSlider) {
                    setControlsVisible(false);
                }
            }, 900);
        }
    };

    // Doble click seek (vibes streaming)
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
                {/* Dejamos tracks por compatibilidad aunque no haya botón CC */}
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
                <div className="akira-top-left">
                    <button
                        type="button"
                        className="akira-ghost-btn akira-back-btn"
                        onClick={() => {
                            if (onBack) onBack();
                            else window.history.back();
                        }}
                        aria-label="Volver"
                        title="Volver"
                    >
                        ←
                    </button>
                </div>

                <div className="akira-top-meta">
                    <div className="akira-channel">{channelLabel}</div>
                    <div className="akira-title">{title}</div>
                </div>
            </div>

            {/* CENTER FEEDBACK */}
            <div className={`akira-feedback ${feedback?.visible ? "show" : ""}`} aria-hidden="true">
                <div className="akira-feedback-pill">{feedback?.text ?? ""}</div>
            </div>

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
                        {/* Track visual custom (buffer + progress) */}
                        <div className="akira-progress-visual" aria-hidden="true">
                            <div className="akira-progress-track" />
                            <div className="akira-progress-buffered" style={{ width: `${bufferedPct}%` }} />
                            <div className="akira-progress-played" style={{ width: `${progressPct}%` }} />
                        </div>

                        {/* Native input oculto visualmente, se usa para interacción */}
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

                        {/* Hover preview thumbnails */}
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

                {/* Toolbar */}
                <div className="akira-toolbar">
                    {/* Cluster central grande */}
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
                        />

                        <IconButton
                            onClick={() => seekBy(10)}
                            icon={ICONS.forward}
                            label="Adelantar 10s"
                            size="xl"
                        />
                    </div>

                    {/* Derecha grande */}
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
                                    className="akira-volume-slider"
                                    type="range"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={muted ? 0 : volume}
                                    onChange={(e) => onVolumeInput(Number(e.target.value))}
                                    aria-label="Volumen"
                                />
                            </div>
                        </div>

                        {/* Episodes placeholder */}
                        <div className="akira-menu-wrap">
                            <IconButton
                                onClick={() => {
                                    setShowEpisodes((v) => !v);
                                    showControlsTemporarily();
                                }}
                                icon={ICONS.episodes}
                                label="Episodios"
                                size="lg"
                            />

                            {showEpisodes && (
                                <div className="akira-menu">
                                    <button type="button" className="akira-menu-item" onClick={() => setShowEpisodes(false)}>
                                        Episodio 1
                                    </button>
                                    <button type="button" className="akira-menu-item" onClick={() => setShowEpisodes(false)}>
                                        Episodio 2
                                    </button>
                                    <button type="button" className="akira-menu-item" onClick={() => setShowEpisodes(false)}>
                                        Episodio 3
                                    </button>
                                </div>
                            )}
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
};

function IconButton({
    onClick,
    icon,
    label,
    size = "lg",
    emphasized = false
}: IconButtonProps) {
    return (
        <button
            type="button"
            className={`akira-icon-btn ${size} ${emphasized ? "emphasized" : ""}`}
            onClick={onClick}
            aria-label={label}
            title={label}
        >
            <img src={icon} alt="" />
        </button>
    );
}