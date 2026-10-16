/*
 * StreamBoost — mejora la fluidez de las transmisiones de pantalla en Vesktop.
 *
 * Vesktop transmite con el WebRTC de Chromium (como Discord en el navegador). Por defecto,
 * cuando el PC o la conexión se ajustan, Chromium baja los FPS para conservar nitidez.
 * Este plugin le pide que conserve los FPS, quita topes de FPS/bitrate y marca el video
 * como "movimiento". Además puede mostrar un panel con FPS, resolución, bitrate,
 * codificador y el motivo de cualquier limitación (CPU o ancho de banda).
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";

const Native = VencordNative.pluginHelpers.StreamBoost as PluginNative<typeof import("./native")>;

const logger = new Logger("StreamBoost");

const settings = definePluginSettings({
    priority: {
        type: OptionType.SELECT,
        description: "Qué conservar cuando el PC o la conexión no dan para todo",
        options: [
            { label: "Fluidez (mantener FPS) — recomendado para juegos", value: "maintain-framerate", default: true },
            { label: "Equilibrado (comportamiento normal de Chromium)", value: "balanced" },
            { label: "Nitidez (mantener resolución, baja FPS)", value: "maintain-resolution" }
        ]
    },
    targetFps: {
        type: OptionType.SELECT,
        description: "FPS de la captura (fuerza este valor aunque Vesktop no lo aplique)",
        options: [
            { label: "60 FPS", value: 60, default: true },
            { label: "30 FPS", value: 30 },
            { label: "No tocar (usar lo que elija Vesktop)", value: 0 }
        ]
    },
    maxBitrate: {
        type: OptionType.SLIDER,
        description: "Bitrate máximo del video (Mbps). Más alto = mejor calidad si tu internet de subida lo aguanta",
        markers: [2, 4, 6, 8, 10, 12, 15, 20],
        default: 8,
        stickToMarkers: false
    },
    forceGpu: {
        type: OptionType.BOOLEAN,
        description: "Intentar codificar con la tarjeta gráfica (quita las capas temporales que obligan a usar el procesador)",
        default: true
    },
    gpuProfile: {
        type: OptionType.BOOLEAN,
        description: "Usar el perfil H264 \"Baseline\" (tu tarjeta lo codifica por hardware) en vez de \"Constrained Baseline\" (solo por procesador). Requiere volver a empezar la transmisión",
        default: true
    },
    motionHint: {
        type: OptionType.BOOLEAN,
        description: "Marcar la transmisión como contenido en movimiento (juegos/video)",
        default: true
    },
    showStats: {
        type: OptionType.BOOLEAN,
        description: "Mostrar un panel con FPS, resolución, bitrate y codificador mientras transmites",
        default: true
    }
});

// ---- Conexiones WebRTC que Discord crea ----
const pcs = new Set<RTCPeerConnection>();
let origSLD: RTCPeerConnection["setLocalDescription"] | null = null;
let origSetParams: RTCRtpSender["setParameters"] | null = null;
let origSRD: RTCPeerConnection["setRemoteDescription"] | null = null;

// Discord pide H264 "Constrained Baseline" (42e0xx). En Windows, Chromium solo tiene codificador por GPU
// para Baseline/Main/High, así que cae a OpenH264 (procesador). Cambiamos el perfil a Baseline (4200xx),
// que cualquier decodificador reproduce igual. Se cambia en ambas descripciones de la misma conexión.
const H264_CBP = /profile-level-id=42e0([0-9a-f]{2})/gi;
const mungedPcs = new WeakSet<RTCPeerConnection>();
function mungeDesc(pc: RTCPeerConnection, desc: any, first: boolean) {
    if (!settings.store.gpuProfile || !desc?.sdp || typeof desc.sdp !== "string") return desc;
    if (!first && !mungedPcs.has(pc)) return desc;
    if (!H264_CBP.test(desc.sdp)) return desc;
    H264_CBP.lastIndex = 0;
    mungedPcs.add(pc);
    return { type: desc.type, sdp: desc.sdp.replace(H264_CBP, "profile-level-id=4200$1") };
}
function isFirstDesc(pc: RTCPeerConnection) {
    return !pc.currentLocalDescription && !pc.currentRemoteDescription && !pc.pendingLocalDescription && !pc.pendingRemoteDescription;
}

function isDisplayTrack(t: MediaStreamTrack | null): t is MediaStreamTrack {
    if (!t || t.kind !== "video" || t.readyState !== "live") return false;
    const s = t.getSettings() as any;
    return "displaySurface" in s || /screen|window|web-contents/i.test(t.label);
}

function wantedFps(track: MediaStreamTrack) {
    return settings.store.targetFps || Math.max(30, Math.round(track.getSettings().frameRate ?? 30));
}

function boostParams(p: RTCRtpSendParameters, track: MediaStreamTrack): RTCRtpSendParameters {
    const fps = wantedFps(track);
    (p as any).degradationPreference = settings.store.priority;
    const cap = Math.round(settings.store.maxBitrate * 1_000_000);
    for (const e of p.encodings ?? []) {
        if (e.active === false) continue;
        e.maxFramerate = Math.max(e.maxFramerate ?? 0, fps);
        if (!e.maxBitrate || e.maxBitrate < cap) e.maxBitrate = cap;
        if (settings.store.forceGpu && (e as any).scalabilityMode && (e as any).scalabilityMode !== "L1T1") (e as any).scalabilityMode = "L1T1";
        (e as any).priority = "high";
        (e as any).networkPriority = "high";
    }
    return p;
}

function needsBoost(p: RTCRtpSendParameters, track: MediaStreamTrack) {
    if ((p as any).degradationPreference !== settings.store.priority) return true;
    const cap = Math.round(settings.store.maxBitrate * 1_000_000);
    const fps = wantedFps(track);
    return (p.encodings ?? []).some(e => e.active !== false && ((e.maxBitrate ?? 0) < cap || (e.maxFramerate ?? 0) < fps
        || (settings.store.forceGpu && (e as any).scalabilityMode && (e as any).scalabilityMode !== "L1T1")));
}

// Vesktop intenta poner los FPS elegidos con applyConstraints (pidiendo un mínimo de FPS), pero
// a veces esa llamada falla y la captura se queda en 30 FPS. Aquí pedimos solo el frameRate.
const fpsTried = new WeakMap<MediaStreamTrack, number>();
async function ensureCaptureFps(track: MediaStreamTrack) {
    const target = settings.store.targetFps;
    if (!target) return;
    const current = track.getSettings().frameRate ?? 0;
    if (current >= target - 1 || fpsTried.get(track) === target) return;
    fpsTried.set(track, target);
    const base = { ...track.getConstraints() } as MediaTrackConstraints;
    for (const k of ["width", "height", "advanced"] as const)
        if (JSON.stringify(base[k] ?? null).includes("null")) delete base[k]; // valores inválidos (NaN)
    try {
        await track.applyConstraints({ ...base, frameRate: { ideal: target, max: target } });
    } catch {
        try { await track.applyConstraints({ frameRate: { ideal: target, max: target } }); }
        catch (e) { logger.warn("No se pudo subir los FPS de la captura", e); }
    }
    logger.info("FPS de captura:", track.getSettings().frameRate);
}

async function applyAll() {
    for (const pc of pcs) {
        if (pc.connectionState === "closed") { pcs.delete(pc); continue; }
        for (const sender of pc.getSenders()) {
            const track = sender.track;
            if (!isDisplayTrack(track)) continue;
            if (settings.store.motionHint && track.contentHint !== "motion") track.contentHint = "motion";
            await ensureCaptureFps(track);
            try {
                const p = sender.getParameters();
                if (!p.encodings?.length || !needsBoost(p, track)) continue;
                await sender.setParameters(p); // nuestro setParameters envuelto aplica los valores
            } catch (e) {
                logger.debug("setParameters falló (se reintenta)", e);
            }
        }
    }
}

// ---- Estadísticas ----
// ¿Tiene Chromium un codificador H264 por GPU disponible? (se calcula una vez)
let gpuH264: string | null = null;
async function probeGpu() {
    if (gpuH264 !== null) return;
    gpuH264 = "?";
    const parts: string[] = [];
    try {
        const r = await (window as any).VideoEncoder?.isConfigSupported({ codec: "avc1.42e01f", width: 1920, height: 1080, bitrate: 6e6, framerate: 60, hardwareAcceleration: "prefer-hardware" });
        parts.push(`WebCodecs ${r?.supported ? "sí" : "no"}`);
    } catch { parts.push("WebCodecs ?"); }
    try {
        const r = await navigator.mediaCapabilities.encodingInfo({ type: "webrtc", video: { contentType: "video/H264;profile-level-id=42e01f;packetization-mode=1", width: 1920, height: 1080, bitrate: 6e6, framerate: 60 } } as any);
        parts.push(`WebRTC ${r.powerEfficient ? "sí" : "no"}`);
    } catch { parts.push("WebRTC ?"); }
    gpuH264 = parts.join(", ");
    try { await Native.gpuDiagnostics(); } catch { }
}

const prev = new WeakMap<RTCPeerConnection, { bytes: number; t: number; }>();
let panel: HTMLDivElement | null = null;

const REASONS: Record<string, string> = {
    none: "ninguna",
    cpu: "CPU (el PC no da abasto codificando)",
    bandwidth: "ancho de banda (tu internet de subida)",
    other: "otra"
};

async function collectStats() {
    const lines: string[] = [];
    for (const pc of pcs) {
        const dTrack = pc.getSenders().map(s => s.track).find(isDisplayTrack);
        if (!dTrack) continue;
        const captureFps = dTrack.getSettings().frameRate ?? 0;
        let report: RTCStatsReport;
        try { report = await pc.getStats(); } catch { continue; }

        let out: any = null;
        const codecs = new Map<string, any>();
        report.forEach((s: any) => {
            if (s.type === "codec") codecs.set(s.id, s);
            if (s.type === "outbound-rtp" && s.kind === "video" && (!out || (s.bytesSent ?? 0) > (out.bytesSent ?? 0))) out = s;
        });
        if (!out) continue;

        const now = performance.now();
        const last = prev.get(pc);
        prev.set(pc, { bytes: out.bytesSent ?? 0, t: now });
        const mbps = last ? (((out.bytesSent ?? 0) - last.bytes) * 8 / ((now - last.t) / 1000) / 1e6) : 0;
        const codecInfo = codecs.get(out.codecId);
        const plid = /profile-level-id=([0-9a-f]{6})/i.exec(codecInfo?.sdpFmtpLine ?? "")?.[1]?.toLowerCase();
        const profile = !plid ? "" : plid.startsWith("42e0") ? " Constrained Baseline" : plid.startsWith("42") ? " Baseline" : plid.startsWith("4d") ? " Main" : plid.startsWith("64") ? " High" : ` ${plid}`;
        const codec = (codecInfo?.mimeType?.replace("video/", "") ?? "?") + profile;
        const sender = pc.getSenders().find(s => s.track === dTrack);
        const encs = sender?.getParameters().encodings ?? [];
        const layers = encs.map(e => (e as any).scalabilityMode ?? "L1T1").join("+") || "?";
        void probeGpu();
        const hw = out.powerEfficientEncoder === true ? "por hardware (GPU)" : out.powerEfficientEncoder === false ? "por software (CPU)" : "";

        lines.push(
            `${out.frameWidth ?? "?"}×${out.frameHeight ?? "?"} · ${Math.round(out.framesPerSecond ?? 0)} FPS (captura: ${Math.round(captureFps)}) · ${mbps.toFixed(1)} Mbps`,
            `Codificador: ${codec} ${hw}${out.encoderImplementation ? ` (${out.encoderImplementation})` : ""}`,
            `Limitado por: ${REASONS[out.qualityLimitationReason] ?? out.qualityLimitationReason ?? "?"}`,
            `Capas: ${layers}${encs.length > 1 ? ` (${encs.length} calidades)` : ""} · GPU H264: ${gpuH264 ?? "…"}`
        );
    }
    return lines;
}

function renderPanel(lines: string[]) {
    if (!settings.store.showStats || !lines.length) { panel?.remove(); panel = null; return; }
    if (!panel) {
        panel = document.createElement("div");
        panel.className = "vc-streamboost";
        Object.assign(panel.style, {
            position: "fixed", left: "12px", bottom: "12px", zIndex: "9999", padding: "6px 10px",
            borderRadius: "8px", background: "rgba(0,0,0,.75)", color: "#fff", font: "12px/1.45 var(--font-code, monospace)",
            pointerEvents: "none", whiteSpace: "pre"
        } as CSSStyleDeclaration);
        document.body.appendChild(panel);
    }
    panel.textContent = "StreamBoost\n" + lines.join("\n");
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
async function tick() {
    if (busy || !pcs.size) { if (!pcs.size) renderPanel([]); return; }
    busy = true;
    try {
        await applyAll();
        renderPanel(await collectStats());
    } finally { busy = false; }
}

export default definePlugin({
    name: "StreamBoost",
    description: "Transmisiones de pantalla más fluidas en Vesktop: prioriza los FPS, sube el tope de bitrate y muestra estadísticas (FPS, bitrate, codificador, qué te limita).",
    authors: [{ name: "Richardant", id: 0n }],
    settings,

    start() {
        origSLD = RTCPeerConnection.prototype.setLocalDescription;
        RTCPeerConnection.prototype.setLocalDescription = function (this: RTCPeerConnection, ...args: any[]) {
            pcs.add(this);
            try { if (args[0]) args[0] = mungeDesc(this, args[0], isFirstDesc(this) || mungedPcs.has(this)); } catch { }
            const r = (origSLD as any).apply(this, args);
            Promise.resolve(r).then(() => setTimeout(tick, 200), () => { });
            return r;
        } as any;

        origSRD = RTCPeerConnection.prototype.setRemoteDescription;
        RTCPeerConnection.prototype.setRemoteDescription = function (this: RTCPeerConnection, ...args: any[]) {
            try { if (args[0]) args[0] = mungeDesc(this, args[0], isFirstDesc(this) || mungedPcs.has(this)); } catch { }
            return (origSRD as any).apply(this, args);
        } as any;

        origSetParams = RTCRtpSender.prototype.setParameters;
        RTCRtpSender.prototype.setParameters = function (this: RTCRtpSender, params: RTCRtpSendParameters, ...rest: any[]) {
            try {
                if (isDisplayTrack(this.track) && params?.encodings?.length) boostParams(params, this.track);
            } catch (e) { logger.error(e); }
            return (origSetParams as any).call(this, params, ...rest);
        } as any;

        timer = setInterval(tick, 2000);
    },

    stop() {
        if (origSLD) RTCPeerConnection.prototype.setLocalDescription = origSLD;
        if (origSetParams) RTCRtpSender.prototype.setParameters = origSetParams;
        if (origSRD) RTCPeerConnection.prototype.setRemoteDescription = origSRD;
        origSRD = null;
        origSLD = origSetParams = null;
        if (timer) clearInterval(timer);
        timer = null;
        panel?.remove();
        panel = null;
    }
});
