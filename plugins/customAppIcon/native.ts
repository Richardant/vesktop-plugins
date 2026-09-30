/*
 * CustomAppIcon (native / proceso principal de Vesktop)
 * Cambia el icono de las ventanas de Vesktop (barra de tareas y alt+tab) por una imagen que elija el usuario.
 * La imagen se copia junto a los archivos de Vencord y se aplica a cada ventana nueva.
 */

import { app, BrowserWindow, dialog, IpcMainInvokeEvent, nativeImage, NativeImage } from "electron";
import { copyFileSync, existsSync, readdirSync, rmSync } from "fs";
import { extname, join } from "path";

const PREFIX = "customAppIcon";

function currentIconPath() {
    try {
        const f = readdirSync(__dirname).find(n => n.startsWith(PREFIX + "."));
        return f ? join(__dirname, f) : null;
    } catch {
        return null;
    }
}

// Vesktop pone el numerito de notificaciones (overlay) solo cuando cambia la cantidad.
// Cambiar el icono de la ventana hace que Windows lo borre, así que recordamos el último
// overlay de cada ventana y lo volvemos a poner después de cada cambio de icono.
type Overlay = [NativeImage | null, string];
const lastOverlay = new WeakMap<BrowserWindow, Overlay>();
const origSetOverlay = BrowserWindow.prototype.setOverlayIcon;
BrowserWindow.prototype.setOverlayIcon = function (this: BrowserWindow, overlay: NativeImage | null, description: string) {
    lastOverlay.set(this, [overlay, description]);
    return origSetOverlay.call(this, overlay, description);
};

function restoreOverlay(win: BrowserWindow) {
    const o = lastOverlay.get(win);
    if (o && !win.isDestroyed()) origSetOverlay.call(win, o[0], o[1]);
}

let customIcon: NativeImage | null = null;
let defaultIcon: NativeImage | null = null;

function loadIcon() {
    const p = currentIconPath();
    const img = p ? nativeImage.createFromPath(p) : null;
    customIcon = img && !img.isEmpty() ? img : null;
}

function applyTo(win: BrowserWindow) {
    if (win.isDestroyed()) return;
    if (customIcon) win.setIcon(customIcon);
    else if (defaultIcon) win.setIcon(defaultIcon);
    restoreOverlay(win);
}

function applyAll() {
    for (const w of BrowserWindow.getAllWindows()) applyTo(w);
}

loadIcon();
app.on("browser-window-created", (_e, win) => {
    if (customIcon) applyTo(win);
    // Vesktop puede fijar su icono al terminar de crear la ventana; lo volvemos a aplicar
    win.once("ready-to-show", () => customIcon && applyTo(win));
    // Windows puede recrear el botón de la barra de tareas (al mostrar/restaurar la ventana)
    // y perder el numerito; lo reponemos.
    const reapply = () => { if (customIcon) setTimeout(() => restoreOverlay(win), 300); };
    win.on("show", reapply);
    win.on("restore", reapply);
});
app.whenReady().then(async () => {
    try { defaultIcon = await app.getFileIcon(process.execPath, { size: "large" }); } catch { }
    if (customIcon) applyAll();
});

export function getIconPath(_: IpcMainInvokeEvent) {
    return currentIconPath();
}

/** Abre un selector de archivo, guarda la imagen elegida y la aplica. */
export async function chooseIcon(_: IpcMainInvokeEvent): Promise<string | null> {
    const res = await dialog.showOpenDialog({
        title: "Elegir icono para Vesktop",
        properties: ["openFile"],
        filters: [{ name: "Imágenes", extensions: ["png", "ico", "jpg", "jpeg"] }]
    });
    if (res.canceled || !res.filePaths[0]) return null;

    const src = res.filePaths[0];
    const img = nativeImage.createFromPath(src);
    if (img.isEmpty()) throw new Error("No se pudo leer esa imagen");

    const old = currentIconPath();
    if (old) rmSync(old, { force: true });
    const dest = join(__dirname, PREFIX + extname(src).toLowerCase());
    copyFileSync(src, dest);

    loadIcon();
    applyAll();
    return dest;
}

export function resetIcon(_: IpcMainInvokeEvent) {
    const old = currentIconPath();
    if (old) rmSync(old, { force: true });
    customIcon = null;
    applyAll();
}

export function hasIcon(_: IpcMainInvokeEvent) {
    return existsSync(currentIconPath() ?? "") && customIcon !== null;
}
