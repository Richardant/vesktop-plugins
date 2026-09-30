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

export function minimize(_: IpcMainInvokeEvent) {
    focusedPopout()?.minimize();
}

// Arrastrar la ventana desde cualquier parte (mantener clic y mover)
let dragWin: BrowserWindow | null = null;
let dragStartPos: [number, number] = [0, 0];

export function dragStart(_: IpcMainInvokeEvent): boolean {
    const win = focusedPopout();
    if (!win || win.isMaximized() || win.isFullScreen()) return false;
    dragWin = win;
    const [x, y] = win.getPosition();
    dragStartPos = [x, y];
    return true;
}

export function dragMove(_: IpcMainInvokeEvent, dx: number, dy: number) {
    if (!dragWin || dragWin.isDestroyed()) return;
    dragWin.setPosition(Math.round(dragStartPos[0] + dx), Math.round(dragStartPos[1] + dy));
}

export function dragEnd(_: IpcMainInvokeEvent) {
    dragWin = null;
}
