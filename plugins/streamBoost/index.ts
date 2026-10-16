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
    h264Profile: {
        type: OptionType.SELECT,
        description: "Perfil H264 de la transmisión. Discord usa \"Constrained Baseline\", que en tu PC solo se codifica con el procesador. Los otros usan la tarjeta gráfica (experimental). Requiere volver a empezar la transmisión",
        options: [
            { label: "Constrained Baseline — procesador (normal de Discord, el más estable)", value: "", default: true },
            { label: "Main — tarjeta gráfica (experimental)", value: "4d00" },
            { label: "Baseline — tarjeta gráfica (experimental; en tu PC congeló la transmisión)", value: "4200" }
        ]
    },
    motionHint: {
        type: OptionType.BOOLEAN,
        description: "Marcar la transmisión como contenido en movimiento (juegos/video), salvo que elijas \"Prefer Clarity\" en el selector",
        default: true
    },
    pickerDefaults: {
        type: OptionType.BOOLEAN,
        description: "Al abrir el selector de transmisión, marcar automáticamente 1080p, 60 FPS y \"Prefer Clarity\"",
        default: true
    },
    showStats: {
        type: OptionType.BOOLEAN,
        description: "Mostrar un panel con FPS, resolución, bitrate y codificador mientras transmites",
        default: true
    }
});

// ---- Valores por defecto del selector de transmisión de Vesktop ----
// El selector es de Vesktop (no de Discord), así que lo ajustamos haciendo clic en sus opciones.
let pickedHint: "motion" | "detail" | null = null;
const handledPickers = new WeakSet<Element>();
let pickerObserver: MutationObserver | null = null;

function findByText(root: Element, text: string) {
    const all = root.querySelectorAll<HTMLElement>("button, [role=radio], [role=button], div, span");
    for (const el of all) {
        if (el.childElementCount === 0 && el.textContent?.trim() === text) return el;
    }
    return null;
}

let pickerRaf = 0;
function checkPicker() {
    if (pickerRaf) return;
    pickerRaf = requestAnimationFrame(() => {
        pickerRaf = 0;
        // Sección de calidad del selector de Vesktop (clase "vcd-screen-picker-quality")
        const quality = document.querySelector('[class*="vcd-screen-picker-quality"]');
        if (!quality) return;
        const root = quality.closest('[class*="vcd-screen-picker"][class*="modal"], [role=dialog]') ?? quality.parentElement ?? quality;
        if (handledPickers.has(root)) return;
        handledPickers.add(root);

        // Recordar qué tipo de contenido elige el usuario
        for (const [label, hint] of [["Prefer Smoothness", "motion"], ["Prefer Clarity", "detail"]] as const)
            findByText(root, label)?.addEventListener("click", () => { pickedHint = hint; }, true);

        if (!settings.store.pickerDefaults) return;
        setTimeout(() => {
            for (const label of ["1080", "60", "Prefer Clarity"]) findByText(root, label)?.click();
            pickedHint = "detail";
        }, 50);
    });
}

// ---- Conexiones WebRTC que Discord crea ----
const pcs = new Set<RTCPeerConnection>();
let origSLD: RTCPeerConnection["setLocalDescription"] | null = null;
let origSetParams: RTCRtpSender["setParameters"] | null = null;
let origSRD: RTCPeerConnection["setRemoteDescription"] | null = null;

// Discord pide H264 "Constrained Baseline" (42e0xx). En Windows, Chromium solo tiene codificador por GPU
// para Baseline/Main/High, así que cae a OpenH264 (procesador). Opcionalmente cambiamos el perfil
// (Main 4d00xx o Baseline 4200xx). Se cambia en ambas descripciones de la misma conexión.
const H264_CBP = /profile-level-id=42e0([0-9a-f]{2})/gi;
const mungedPcs = new WeakSet<RTCPeerConnection>();
function mungeDesc(pc: RTCPeerConnection, desc: any, first: boolean) {
    const prefix = settings.store.h264Profile;
    if (!prefix || !desc?.sdp || typeof desc.sdp !== "string") return desc;
    if (!first && !mungedPcs.has(pc)) return desc;
    if (!H264_CBP.test(desc.sdp)) return desc;
    H264_CBP.lastIndex = 0;
    mungedPcs.add(pc);
    return { type: desc.type, sdp: desc.sdp.replace(H264_CBP, `profile-level-id=${prefix}$1`) };
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
            const hint = pickedHint === "detail" ? "detail" : settings.store.motionHint ? "motion" : null;
            if (hint && track.contentHint !== hint) track.contentHint = hint;
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

// ---- Prueba de codificación (diagnóstico) ----
// Codifica unos segundos con una conexión local (sin red) y anota si salen cuadros y con qué codificador.
async function encodeTest(label: string, track: MediaStreamTrack, prof: string) {
    const a = new RTCPeerConnection(), z = new RTCPeerConnection();
    const res: any = { label, prof, settings: track.getSettings() };
    try {
        a.onicecandidate = e => e.candidate && z.addIceCandidate(e.candidate);
        z.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate);
        const tr = a.addTransceiver(track, { direction: "sendonly" });
        const codecs = (RTCRtpSender.getCapabilities("video")?.codecs ?? []).filter(c => c.mimeType === "video/H264" && c.sdpFmtpLine?.includes("profile-level-id=" + prof) && c.sdpFmtpLine.includes("packetization-mode=1"));
        res.codecFound = codecs.length;
        if (!codecs.length) return res;
        tr.setCodecPreferences(codecs);
        await (origSLD as any).call(a);
        await (origSRD as any).call(z, a.localDescription!);
        await (origSLD as any).call(z);
        await (origSRD as any).call(a, z.localDescription!);
        await new Promise(r => setTimeout(r, 5000));
        (await a.getStats()).forEach((x: any) => {
            if (x.type === "outbound-rtp" && x.kind === "video")
                Object.assign(res, { framesEncoded: x.framesEncoded, bytesSent: x.bytesSent, fps: x.framesPerSecond, w: x.frameWidth, h: x.frameHeight, impl: x.encoderImplementation, hw: x.powerEfficientEncoder, limit: x.qualityLimitationReason });
        });
    } catch (e) {
        res.error = String(e);
    } finally {
        a.close(); z.close();
    }
    return res;
}

async function canvasSelfTest() {
    const c = document.createElement("canvas");
    c.width = 1592; c.height = 1040;
    const ctx = c.getContext("2d")!;
    let i = 0;
    const iv = setInterval(() => { ctx.fillStyle = `hsl(${i++ * 7 % 360},80%,50%)`; ctx.fillRect(0, 0, c.width, c.height); }, 16);
    try {
        for (const prof of ["42e01f", "4d001f"]) {
            const t = c.captureStream(60).getVideoTracks()[0];
            await Native.saveSelfTest(await encodeTest("lienzo", t, prof));
            t.stop();
        }
    } finally { clearInterval(iv); }
}

// Si la transmisión real usa la GPU pero no salen cuadros, probamos con una copia de la captura.
let streamTested = false;
async function streamSelfTest(track: MediaStreamTrack) {
    if (streamTested) return;
    streamTested = true;
    for (const prof of ["4d001f", "42e01f"]) {
        const t = track.clone();
        await Native.saveSelfTest(await encodeTest("captura", t, prof));
        t.stop();
    }
}

// Si el codificador por GPU arranca pero no saca cuadros, lo reiniciamos quitando y volviendo a poner la imagen.
const recovered = new WeakSet<RTCPeerConnection>();
async function recoverEncoder(pc: RTCPeerConnection, sender: RTCRtpSender | undefined, track: MediaStreamTrack) {
    if (!sender || recovered.has(pc)) return;
    recovered.add(pc);
    try {
        await sender.replaceTrack(null);
        await new Promise(r => setTimeout(r, 300));
        await sender.replaceTrack(track);
        logger.info("Codificador reiniciado");
    } catch (e) { logger.warn("No se pudo reiniciar el codificador", e); }
}

const zeroSince = new WeakMap<RTCPeerConnection, number>();
// Cuánto tarda en salir el primer cuadro de cada transmisión (para diagnosticar arranques lentos)
const streamStart = new WeakMap<RTCPeerConnection, number>();
const startLogged = new WeakSet<RTCPeerConnection>();
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
        if (!streamStart.has(pc)) streamStart.set(pc, now);
        if (out.framesEncoded && !startLogged.has(pc)) {
            startLogged.add(pc);
            void Native.saveSelfTest({ label: "inicio", msHastaPrimerCuadro: Math.round(now - streamStart.get(pc)!), reiniciado: recovered.has(pc), codec, impl: out.encoderImplementation });
        }
        if (!out.framesEncoded) {
            if (!zeroSince.has(pc)) zeroSince.set(pc, now);
            else if (now - zeroSince.get(pc)! > 3000) {
                if (!recovered.has(pc)) void recoverEncoder(pc, sender, dTrack);
                else if (now - zeroSince.get(pc)! > 10000) void streamSelfTest(dTrack);
            }
        } else zeroSince.delete(pc);
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

        timer = setInterval(tick, 1000);
        pickerObserver = new MutationObserver(() => checkPicker());
        pickerObserver.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => void canvasSelfTest().catch(e => logger.error("selftest", e)), 15000);
    },

    stop() {
        if (origSLD) RTCPeerConnection.prototype.setLocalDescription = origSLD;
        if (origSetParams) RTCRtpSender.prototype.setParameters = origSetParams;
        if (origSRD) RTCPeerConnection.prototype.setRemoteDescription = origSRD;
        origSRD = null;
        origSLD = origSetParams = null;
        if (timer) clearInterval(timer);
        timer = null;
        pickerObserver?.disconnect();
        pickerObserver = null;
        panel?.remove();
        panel = null;
    }
});
