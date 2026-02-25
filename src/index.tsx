import React from "react";
import { createRoot } from "react-dom/client";
import { AkiraPlayer } from "./player/AkiraPlayer";
import "./player/akira-player.css";

export type SubtitleTrackInput = {
  src: string;
  srclang: string;
  label: string;
  default?: boolean;
};

export type AkiraPlayerOptions = {
  // Video source (HLS m3u8)
  src: string;

  // UI
  poster?: string;
  autoplay?: boolean;
  title?: string;
  channelLabel?: string; // Ej: HBO, SATV+, etc.

  // Assets (íconos)
  // Local preview: "/dist/assets"
  // Producción Vercel sirviendo dist como root: "/assets"
  assetBase?: string;

  // Continue Watching (Supabase)
  contentId: string;
  seasonId?: string | null;
  episodeId?: string | null;

  // VTT thumbnails preview (hover del timeline)
  thumbnailsVtt?: string;

  // Subtítulos VTT reales
  subtitles?: SubtitleTrackInput[];

  // Callback opcional (ej: botón back)
  onBack?: () => void;
};

export function mount(target: string | Element, options: AkiraPlayerOptions) {
  const el = typeof target === "string" ? document.querySelector(target) : target;
  if (!el) throw new Error("AkiraPlayer: target not found");

  const root = createRoot(el);
  root.render(<AkiraPlayer {...options} />);

  return {
    unmount: () => root.unmount()
  };
}

// Para consumidores UMD que lean default
export default { mount };