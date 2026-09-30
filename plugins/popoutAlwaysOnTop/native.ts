/*
 * PopoutAlwaysOnTop (native / proceso principal de Vesktop)
 * Fija o suelta "siempre encima" en la ventana emergente (popout) que tiene el foco.
 * Al pulsar el botón dentro del popout, ese popout es la ventana enfocada.
 */

import { BrowserWindow, IpcMainInvokeEvent } from "electron";

function focusedPopout() {
    const win = BrowserWindow.getFocusedWindow();
    if (!win || win.isDestroyed()) return null;
    // Solo popouts de Discord (nunca la ventana principal)
    return win.webContents.getURL().includes("/popout") ? win : null;
}

/** Cambia el estado y devuelve el nuevo (o null si no hay popout enfocado). */
export function toggle(_: IpcMainInvokeEvent): boolean | null {
    const win = focusedPopout();
    if (!win) return null;
    const next = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(next);
    return next;
}

export function set(_: IpcMainInvokeEvent, value: boolean): boolean | null {
    const win = focusedPopout();
    if (!win) return null;
    win.setAlwaysOnTop(value);
    return value;
}
