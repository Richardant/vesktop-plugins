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

// Último estado por ventana, para volver a poner los botones si Windows los borra
// (al ocultar/mostrar la ventana, minimizar a la bandeja, cambiar el icono, etc.)
const lastState = new WeakMap<BrowserWindow, VoiceState | null>();
const hooked = new WeakSet<BrowserWindow>();

function apply(win: BrowserWindow) {
    if (win.isDestroyed()) return;
    const state = lastState.get(win) ?? null;
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
    // Devuelve false si la ventana aún no tiene botón en la barra (p. ej. oculta en la bandeja)
    win.setThumbarButtons(buttons);
}

export function update(e: IpcMainInvokeEvent, state: VoiceState | null) {
    if (process.platform !== "win32") return;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;

    lastState.set(win, state);
    if (!hooked.has(win)) {
        hooked.add(win);
        const reapply = () => setTimeout(() => apply(win), 300);
        win.on("show", reapply);
        win.on("restore", reapply);
        win.on("focus", reapply);
        // Por si Windows los borra sin avisar, revisarlos cada pocos segundos
        const t = setInterval(() => { if (win.isDestroyed()) clearInterval(t); else if (lastState.get(win)) apply(win); }, 5000);
    }
    apply(win);
}
