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

    start() {
        MediaEngineStore.addChangeListener(sync);
        SelectedChannelStore.addChangeListener(sync);
        sync();
    },

    stop() {
        MediaEngineStore.removeChangeListener(sync);
        SelectedChannelStore.removeChangeListener(sync);
        last = "";
        void Native.update(null);
    }
});
