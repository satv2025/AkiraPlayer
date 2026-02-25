export type ThumbnailCue = {
    start: number;
    end: number;
    url: string;
    xywh?: { x: number; y: number; w: number; h: number };
};

function parseTimeToSeconds(t: string): number {
    // Formatos soportados:
    // HH:MM:SS.mmm
    // MM:SS.mmm
    const parts = t.trim().split(":").map(Number);

    if (parts.length === 3) {
        return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
        return parts[0] * 60 + parts[1];
    }
    return Number(t) || 0;
}

function parseXYWH(fragment: string) {
    const m = fragment.match(/xywh=(\d+),(\d+),(\d+),(\d+)/i);
    if (!m) return undefined;
    return {
        x: Number(m[1]),
        y: Number(m[2]),
        w: Number(m[3]),
        h: Number(m[4])
    };
}

function resolveMaybeRelativeUrl(vttUrl: string, payloadUrl: string) {
    try {
        return new URL(payloadUrl, vttUrl).toString();
    } catch {
        return payloadUrl;
    }
}

export async function loadThumbnailVtt(vttUrl: string): Promise<ThumbnailCue[]> {
    const res = await fetch(vttUrl);
    if (!res.ok) throw new Error(`No se pudo cargar VTT thumbnails: ${res.status}`);

    const text = await res.text();
    const lines = text.replace(/\r/g, "").split("\n");
    const cues: ThumbnailCue[] = [];

    let i = 0;
    while (i < lines.length) {
        const line = lines[i].trim();

        // Saltar vacíos / cabecera / líneas no cue
        if (!line || line === "WEBVTT") {
            i++;
            continue;
        }

        // Si hay ID de cue, la siguiente línea debería ser el timestamp
        let timingLine = line;
        if (!line.includes("-->")) {
            i++;
            if (i >= lines.length) break;
            timingLine = lines[i].trim();
        }

        if (!timingLine.includes("-->")) {
            i++;
            continue;
        }

        const [startRaw, endRaw] = timingLine.split("-->").map((s) => s.trim());
        const start = parseTimeToSeconds(startRaw.split(" ")[0]);
        const end = parseTimeToSeconds(endRaw.split(" ")[0]);

        // payload en próxima línea no vacía
        i++;
        while (i < lines.length && !lines[i].trim()) i++;
        if (i >= lines.length) break;

        const payload = lines[i].trim();

        let url = payload;
        let xywh;

        const hashIdx = payload.indexOf("#");
        if (hashIdx >= 0) {
            url = payload.slice(0, hashIdx);
            xywh = parseXYWH(payload.slice(hashIdx + 1));
        }

        cues.push({
            start,
            end,
            url: resolveMaybeRelativeUrl(vttUrl, url),
            xywh
        });

        i++;
    }

    return cues;
}

export function findThumbnailCue(cues: ThumbnailCue[], timeSec: number): ThumbnailCue | null {
    for (const cue of cues) {
        if (timeSec >= cue.start && timeSec < cue.end) return cue;
    }
    return cues.length ? cues[cues.length - 1] : null;
}