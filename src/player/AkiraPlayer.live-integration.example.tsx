// reproductor/AkiraPlayer.live-integration.example.tsx
// EJEMPLO (no reemplaza tu TSX real): cómo leer props live del watch.js

import React, { useEffect, useMemo, useState } from "react";
import { formatCountdown, formatLiveDateTimeAr, isUpcomingLive, parseLiveDate } from "./akira-live-utils";

type Props = {
  title?: string;
  src: string;
  isLiveMode?: boolean;
  liveStartsAt?: string | null;
  streamType?: "live" | "on-demand";
  disableResumeForLive?: boolean;
};

export default function AkiraPlayerLiveExample(props: Props) {
  const [now, setNow] = useState(() => Date.now());

  const startDate = useMemo(() => parseLiveDate(props.liveStartsAt), [props.liveStartsAt]);
  const upcoming = !!props.isLiveMode && isUpcomingLive(true, props.liveStartsAt);
  const display = useMemo(() => formatLiveDateTimeAr(props.liveStartsAt), [props.liveStartsAt]);

  useEffect(() => {
    if (!upcoming) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [upcoming]);

  const diff = startDate ? startDate.getTime() - now : 0;

  return (
    <div>
      {props.isLiveMode ? (
        <div className="akira-live-badge">
          {upcoming ? "Próxima transmisión" : "EN VIVO"}
        </div>
      ) : null}

      {upcoming ? (
        <div style={{ marginTop: 8 }}>
          <div>{display.dateTime}</div>
          <div className="akira-live-countdown">Empieza en {formatCountdown(diff)}</div>
        </div>
      ) : null}

      {/* Acá va tu player real */}
      <div data-player-root data-stream-type={props.isLiveMode ? "live" : "on-demand"}>
        {/* video element / vidstack / hls */}
      </div>
    </div>
  );
}
