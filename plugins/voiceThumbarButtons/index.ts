/*
 * VoiceThumbarButtons — mientras estás en un canal de voz, al pasar el mouse por el icono de
 * Vesktop en la barra de tareas aparecen botones de cámara, micrófono, ensordecer y desconectar.
 */

import { Logger } from "@utils/Logger";
import definePlugin, { PluginNative } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { MediaEngineStore, SelectedChannelStore, showToast, Toasts } from "@webpack/common";

const Native = VencordNative.pluginHelpers.VoiceThumbarButtons as PluginNative<typeof import("./native")>;
const logger = new Logger("VoiceThumbarButtons");

const AudioActions = findByPropsLazy("toggleSelfMute", "toggleSelfDeaf");
const VideoActions = findByPropsLazy("setVideoEnabled");
const VoiceChannelActions = findByPropsLazy("selectVoiceChannel", "selectChannel");

function currentState() {
    if (!SelectedChannelStore.getVoiceChannelId()) return null;
    return {
        mute: MediaEngineStore.isSelfMute(),
        deaf: MediaEngineStore.isSelfDeaf(),
        video: MediaEngineStore.isVideoEnabled()
    };
}

// Iconos propios (32x32) con el estilo de la app oficial: gris claro, tachado del mismo color.
const G = "#dbdee1", BG = "#2b2d31";
// Tachado: una línea oscura (separación) y encima la línea gris
const SLASH = `<path d="M5 4l23 23" stroke="${BG}" stroke-width="6" stroke-linecap="round"/><path d="M5 4l23 23" stroke="${G}" stroke-width="2.6" stroke-linecap="round"/>`;
const CAM = `<rect x="3" y="9" width="18" height="14" rx="3" fill="${G}"/><path d="M22.5 14.5l6.5-4v11l-6.5-4z" fill="${G}"/>`;
const MIC = `<rect x="11" y="3" width="10" height="16" rx="5" fill="${G}"/><path d="M7.5 14.5a8.5 8.5 0 0 0 17 0" fill="none" stroke="${G}" stroke-width="2.4" stroke-linecap="round"/><path d="M16 23v5" stroke="${G}" stroke-width="2.4" stroke-linecap="round"/>`;
const HEAD = `<path d="M5.5 19v-3a10.5 10.5 0 0 1 21 0v3" fill="none" stroke="${G}" stroke-width="2.6"/><rect x="4" y="18" width="7" height="10" rx="2.5" fill="${G}"/><rect x="21" y="18" width="7" height="10" rx="2.5" fill="${G}"/>`;
// Teléfono con una "x" (desconectar)
const HANGUP = `<path d="M6 7c0-1.5 1.2-2.5 2.6-2.2l3 .7c.9.2 1.5 1 1.4 1.9l-.3 2.8c0 .5.2 1 .6 1.3l3.4 3.4c.4.4.9.6 1.3.6l2.8-.3c.9-.1 1.7.5 1.9 1.4l.7 3c.3 1.4-.7 2.6-2.2 2.6C13.2 22.2 6 15 6 7z" fill="${G}" transform="translate(-1 5)"/><path d="M21 4l7 7M28 4l-7 7" stroke="${G}" stroke-width="2.4" stroke-linecap="round"/>`;
const SVGS: Record<string, string> = {
    camOn: CAM, camOff: CAM + SLASH,
    micOn: MIC, micOff: MIC + SLASH,
    deafOn: HEAD, deafOff: HEAD + SLASH,
    hangup: HANGUP
};

async function renderIcons() {
    const out: Record<string, string> = {};
    for (const [k, body] of Object.entries(SVGS)) {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">${body}</svg>`;
        const im = new Image();
        im.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
        await im.decode();
        const c = document.createElement("canvas");
        c.width = c.height = 32;
        c.getContext("2d")!.drawImage(im, 0, 0, 32, 32);
        out[k] = c.toDataURL("image/png");
    }
    return out;
}

let last = "";
function sync() {
    const state = currentState();
    const key = JSON.stringify(state);
    if (key === last) return;
    last = key;
    void Native.update(state);
}

export default definePlugin({
    name: "VoiceThumbarButtons",
    description: "En un canal de voz, muestra botones de cámara, micrófono, ensordecer y desconectar en la miniatura de la barra de tareas (como Discord oficial).",
    authors: [{ name: "Richardant", id: 0n }],

    handleAction(action: string) {
        try {
            switch (action) {
                case "mute": AudioActions.toggleSelfMute(); break;
                case "deaf": AudioActions.toggleSelfDeaf(); break;
                case "video": VideoActions.setVideoEnabled(!MediaEngineStore.isVideoEnabled()); break;
                case "disconnect": VoiceChannelActions.selectVoiceChannel(null); break;
            }
        } catch (e) {
            logger.error("Acción fallida:", action, e);
            showToast(`No se pudo ejecutar: ${action}`, Toasts.Type.FAILURE);
        }
        setTimeout(sync, 100);
    },

    async start() {
        try {
            await Native.setIcons(await renderIcons());
        } catch (e) {
            logger.error("No se pudieron dibujar los iconos", e);
        }
        MediaEngineStore.addChangeListener(sync);
        SelectedChannelStore.addChangeListener(sync);
        last = "";
        sync();
    },

    stop() {
        MediaEngineStore.removeChangeListener(sync);
        SelectedChannelStore.removeChangeListener(sync);
        last = "";
        void Native.update(null);
    }
});
