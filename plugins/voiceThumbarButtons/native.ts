/*
 * VoiceThumbarButtons (native / proceso principal de Vesktop)
 * Pone botones en la miniatura de la barra de tareas de Windows (cámara, micrófono,
 * ensordecer y desconectar) mientras estás en un canal de voz, como la app oficial.
 * Los iconos los dibuja la ventana de Discord y llegan aquí como PNG (data URL).
 */

import { BrowserWindow, IpcMainInvokeEvent, nativeImage, ThumbarButton } from "electron";

interface VoiceState { mute: boolean; deaf: boolean; video: boolean; }

let icons: Record<string, string> = {};

export function setIcons(_: IpcMainInvokeEvent, data: Record<string, string>) {
    icons = data;
}

const img = (k: string) => nativeImage.createFromDataURL(icons[k] ?? "");

export function update(e: IpcMainInvokeEvent, state: VoiceState | null) {
    if (process.platform !== "win32") return;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;

    if (!state) {
        win.setThumbarButtons([]);
        return;
    }

    // Al pulsar un botón, le pedimos a la ventana de Discord que haga la acción
    const run = (action: string) => () => {
        win.webContents
            .executeJavaScript(`Vencord.Plugins.plugins.VoiceThumbarButtons?.handleAction?.(${JSON.stringify(action)})`)
            .catch(() => { });
    };

    const buttons: ThumbarButton[] = [
        { icon: img(state.video ? "camOn" : "camOff"), tooltip: state.video ? "Apagar cámara" : "Encender cámara", click: run("video") },
        { icon: img(state.mute ? "micOff" : "micOn"), tooltip: state.mute ? "Activar micrófono" : "Silenciar micrófono", click: run("mute") },
        { icon: img(state.deaf ? "deafOff" : "deafOn"), tooltip: state.deaf ? "Dejar de ensordecer" : "Ensordecer", click: run("deaf") },
        { icon: img("hangup"), tooltip: "Desconectar", click: run("disconnect") }
    ];
    win.setThumbarButtons(buttons);
}
