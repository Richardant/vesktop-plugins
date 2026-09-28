/*
 * AppAudioShare — en Vesktop para Windows, al transmitir una VENTANA con audio,
 * envía solo el audio de esa aplicación (como el Discord oficial) en vez del de todo el escritorio.
 * Si transmites una pantalla completa, se mantiene el audio de todo el escritorio.
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { showToast, Toasts } from "@webpack/common";

const Native = VencordNative.pluginHelpers.AppAudioShare as PluginNative<typeof import("./native")>;
const logger = new Logger("AppAudioShare");

const settings = definePluginSettings({
    showToast: {
        type: OptionType.BOOLEAN,
        description: "Mostrar un aviso con la aplicación cuyo audio se está transmitiendo",
        default: true
    }
});

const SAMPLE_RATE = 48000;
const TARGET_BUFFER = SAMPLE_RATE * 0.06; // ~60 ms de colchón
const MAX_BUFFER = SAMPLE_RATE * 0.25; // si se acumula más de 250 ms, recortamos (evita retraso creciente)

let originalGDM: typeof navigator.mediaDevices.getDisplayMedia | null = null;

function buildAppAudioTrack(captureId: number) {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    const dest = ctx.createMediaStreamDestination();
    const node = ctx.createScriptProcessor(1024, 1, 2);
    const mute = ctx.createGain();
    mute.gain.value = 0;

    // cola de muestras (float) por canal
    let L = new Float32Array(SAMPLE_RATE);
    let R = new Float32Array(SAMPLE_RATE);
    let len = 0;
    let primed = false;

    function push(pcm: Uint8Array) {
        const view = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
        const frames = view.length >> 1;
        if (len + frames > L.length) {
            const size = Math.max(L.length * 2, len + frames);
            const nL = new Float32Array(size); nL.set(L.subarray(0, len)); L = nL;
            const nR = new Float32Array(size); nR.set(R.subarray(0, len)); R = nR;
        }
        for (let i = 0; i < frames; i++) {
            L[len + i] = view[i * 2] / 32768;
            R[len + i] = view[i * 2 + 1] / 32768;
        }
        len += frames;
        if (len > MAX_BUFFER) { // recortar lo más viejo
            const drop = len - TARGET_BUFFER;
            L.copyWithin(0, drop, len); R.copyWithin(0, drop, len);
            len -= drop;
        }
    }

    node.onaudioprocess = e => {
        const oL = e.outputBuffer.getChannelData(0);
        const oR = e.outputBuffer.getChannelData(1);
        const n = oL.length;
        if (!primed && len >= TARGET_BUFFER) primed = true;
        if (!primed || len < n) { oL.fill(0); oR.fill(0); if (len < n) primed = false; return; }
        oL.set(L.subarray(0, n)); oR.set(R.subarray(0, n));
        L.copyWithin(0, n, len); R.copyWithin(0, n, len);
        len -= n;
    };

    node.connect(dest);
    node.connect(mute);
    mute.connect(ctx.destination);
    void ctx.resume();

    let stopped = false;
    const poll = async () => {
        while (!stopped) {
            try {
                const chunk = await Native.readAudio(captureId);
                if (chunk === false) { cleanup(); break; } // la captura ya no existe
                if (chunk?.byteLength) push(chunk);
            } catch (e) { logger.error("readAudio falló", e); }
            await new Promise(r => setTimeout(r, 15));
        }
    };
    void poll();

    const cleanup = () => {
        if (stopped) return;
        stopped = true;
        node.disconnect(); mute.disconnect();
        void ctx.close();
        void Native.stopCapture(captureId);
        logger.info("captura detenida", captureId);
    };

    return { track: dest.stream.getAudioTracks()[0], cleanup };
}

async function patchedGetDisplayMedia(this: MediaDevices, opts?: DisplayMediaStreamOptions) {
    const stream = await originalGDM!.call(this, opts);

    try {
        logger.info("getDisplayMedia", { audioTracks: stream.getAudioTracks().length, video: stream.getVideoTracks()[0]?.label });
        // Solo si el usuario activó el audio en el selector y eligió una ventana
        // (no dependemos de que Chromium haya conseguido audio: con mejoras/surround activas su captura puede venir vacía)

        const target = await Native.getPickedTarget();
        logger.info("target", target, "debug:", await Native.getDebug());
        if (!target) return stream; // pantalla completa u origen desconocido -> audio de todo el escritorio

        if (!target.exclude && /^(ApplicationFrameHost|vesktop)$/i.test(target.name)) {
            if (settings.store.showToast)
                showToast(`No se puede aislar el audio de ${target.name}; se transmite el de todo el escritorio`, Toasts.Type.MESSAGE);
            return stream;
        }

        const res = await Native.startCapture(target.pid, !!target.exclude);
        if (!res.ok) {
            logger.error("No se pudo capturar el audio de la app:", res.error);
            showToast("AppAudioShare: no se pudo capturar el audio de la app, se usa el del escritorio", Toasts.Type.FAILURE);
            return stream;
        }

        const { track, cleanup } = buildAppAudioTrack(res.id!);

        for (const t of stream.getAudioTracks()) { stream.removeTrack(t); t.stop(); }
        stream.addTrack(track);

        // Parar la captura cuando termine ESTA transmisión: Discord llama a track.stop()
        // (que no dispara "ended"), así que también envolvemos stop().
        const video = stream.getVideoTracks()[0];
        for (const t of [video, track]) {
            if (!t) continue;
            t.addEventListener("ended", cleanup);
            const origStop = t.stop.bind(t);
            t.stop = () => { cleanup(); origStop(); };
        }

        if (settings.store.showToast)
            showToast(target.exclude ? `Transmitiendo audio de ${target.name}` : `Transmitiendo solo el audio de: ${target.name}`, Toasts.Type.SUCCESS);
    } catch (e) {
        logger.error("Error, se deja el audio original", e);
    }

    return stream;
}

export default definePlugin({
    name: "AppAudioShare",
    description: "Vesktop (Windows): al transmitir una ventana, envía solo el audio de esa aplicación en vez de todo el escritorio.",
    authors: [{ name: "Richardant", id: 0n }],
    settings,

    start() {
        if (!navigator.mediaDevices?.getDisplayMedia) return;
        originalGDM = navigator.mediaDevices.getDisplayMedia;
        navigator.mediaDevices.getDisplayMedia = patchedGetDisplayMedia;
    },

    stop() {
        if (originalGDM) navigator.mediaDevices.getDisplayMedia = originalGDM;
        originalGDM = null;
    }
});
