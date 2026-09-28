/*
 * AppAudioShare (native / proceso principal de Vesktop)
 *
 * - Escucha la elección del selector de pantalla de Vesktop (canal VCD_IPC_COMMAND)
 *   para saber qué ventana eligió el usuario.
 * - Convierte la ventana (HWND) en PID con PowerShell.
 * - Captura SOLO el audio de ese proceso (y sus hijos) con WASAPI process loopback
 *   usando el addon nativo "loopback-capture" (MIT, WerdoxDev).
 */

import { execFile } from "child_process";
import { desktopCapturer, ipcMain, IpcMainInvokeEvent } from "electron";
import { existsSync } from "fs";
import { join } from "path";

interface Target { pid: number; name: string; exclude?: boolean; }
interface Capture { start(pid: number, includeTree: boolean, cb: (chunk: Buffer) => void): void; stop(): void; }

const ADDON_FILE = "loopback_capture_addon.node";
const MAX_QUEUED_BYTES = 48000 * 4; // ~1 s de PCM 16-bit estéreo 48 kHz

let addon: { LoopbackCapture: new () => Capture; } | null = null;

let pendingTarget: Promise<Target | null> | null = null;
let pendingAt = 0;
let lastDebug = "sin eventos todavía";

function addonAvailable() {
    return existsSync(join(__dirname, ADDON_FILE));
}

function loadAddon() {
    if (addon) return addon;
    const path = join(__dirname, ADDON_FILE);
    if (!existsSync(path)) throw new Error(`No se encontró ${ADDON_FILE} junto a vencordDesktopMain.js`);
    const mod = { exports: {} as any };
    process.dlopen(mod, path);
    addon = mod.exports;
    return addon!;
}

// C# auxiliar: PID por HWND y, si falla, por título exacto de ventana visible.
// Se pasa a PowerShell por variable de entorno (sin armar strings con datos del usuario).
const CS_SOURCE = `
using System; using System.Text; using System.Runtime.InteropServices;
public static class VcAasWin {
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    public static uint ByHwnd(long h) { uint p; GetWindowThreadProcessId(new IntPtr(h), out p); return p; }
    public static uint ByTitle(string t) {
        uint found = 0;
        if (String.IsNullOrEmpty(t)) return 0;
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(1024); GetWindowText(h, sb, 1024);
            if (sb.ToString() == t) { uint p; GetWindowThreadProcessId(h, out p); found = p; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}`;

const PS_SCRIPT =
    "Add-Type -TypeDefinition $env:AAS_CS;" +
    "$p=[VcAasWin]::ByHwnd([int64]$env:AAS_HWND);$how='hwnd';" +
    "if($p -eq 0){$p=[VcAasWin]::ByTitle($env:AAS_TITLE);$how='titulo'};" +
    "$n=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName;" +
    "Write-Output ($p.ToString() + '|' + $n + '|' + $how)";

async function resolveTarget(sourceId: string, hwnd: string): Promise<Target | null> {
    // Título de la ventana elegida, según Electron
    let title = "";
    try {
        const sources = await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } });
        title = sources.find(s => s.id === sourceId)?.name ?? "";
    } catch (e) {
        lastDebug = `getSources falló: ${e}`;
    }

    return new Promise(resolve => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT], {
            windowsHide: true,
            timeout: 10000,
            env: { ...process.env, AAS_CS: CS_SOURCE, AAS_HWND: hwnd, AAS_TITLE: title }
        }, (err, stdout, stderr) => {
            if (err) { lastDebug = `PowerShell falló: ${err} | ${stderr}`; return resolve(null); }
            const [pid, name, how] = stdout.trim().split("|");
            const n = Number(pid);
            lastDebug = `hwnd=${hwnd} titulo="${title}" -> pid=${pid} (${name}) via ${how}`;
            resolve(n > 0 ? { pid: n, name: name || "desconocido" } : null);
        });
    });
}

// Respuesta del selector de pantalla de Vesktop -> { nonce, ok, data: { id: "window:HWND:0", audio, ... } }
// prependListener: nos ejecutamos ANTES que Vesktop para poder quitarle la petición de audio.
// La captura de audio de Chromium falla con dispositivos con mejoras/surround (p. ej. Logitech HX2E)
// y hace que la transmisión ni inicie; el audio lo ponemos nosotros con captura por proceso.
const desktopTarget = (): Target => ({ pid: process.pid, name: "todo el escritorio (sin Vesktop)", exclude: true });

ipcMain.prependListener("VCD_IPC_COMMAND", (_e, msg: any) => {
    const id = msg?.data?.id;
    if (!msg?.ok || typeof id !== "string" || !("audio" in msg.data)) return;

    const m = /^window:(\d+):/.exec(id);
    lastDebug = `pick id=${id} audio=${msg.data.audio}`;
    pendingAt = Date.now();

    if (!msg.data.audio || !addonAvailable()) {
        pendingTarget = Promise.resolve(null); // sin audio, o sin addon -> comportamiento normal de Vesktop
        return;
    }

    msg.data.audio = false; // Vesktop no pedirá audio a Chromium; lo añade el plugin
    pendingTarget = m
        ? resolveTarget(id, m[1]).then(t => t ?? desktopTarget()) // si no se identifica la app, todo menos Vesktop
        : Promise.resolve(desktopTarget());
});

export async function getPickedTarget(_: IpcMainInvokeEvent): Promise<Target | null> {
    if (!pendingTarget || Date.now() - pendingAt > 60_000) return null;
    const t = await pendingTarget;
    pendingTarget = null;
    return t;
}

// Cada captura tiene su propio id: así, al cambiar de ventana o reiniciar la transmisión,
// parar la captura vieja nunca apaga la nueva.
interface Session { cap: Capture; queue: Buffer[]; queued: number; lastRead: number; }
const sessions = new Map<number, Session>();
let nextId = 1;

function stopSession(id: number) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try { s.cap.stop(); } catch { }
}

// Si el renderer deja de leer una captura (p. ej. se cerró sin avisar), se apaga sola.
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.lastRead > 10_000) stopSession(id);
}, 5_000).unref?.();

export function startCapture(_: IpcMainInvokeEvent, pid: number, exclude = false): { ok: boolean; id?: number; error?: string; } {
    try {
        const { LoopbackCapture } = loadAddon();
        const id = nextId++;
        const s: Session = { cap: new LoopbackCapture(), queue: [], queued: 0, lastRead: Date.now() };
        sessions.set(id, s);
        s.cap.start(pid, !exclude, chunk => {
            s.queue.push(Buffer.from(chunk));
            s.queued += chunk.length;
            while (s.queued > MAX_QUEUED_BYTES && s.queue.length > 1) s.queued -= s.queue.shift()!.length;
        });
        lastDebug += ` | captura ${id} iniciada pid=${pid}${exclude ? " (excluir)" : ""} (activas: ${sessions.size})`;
        return { ok: true, id };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}

/** Devuelve el audio pendiente, null si no hay, o false si esa captura ya no existe. */
export function readAudio(_: IpcMainInvokeEvent, id: number): Uint8Array | null | false {
    const s = sessions.get(id);
    if (!s) return false;
    s.lastRead = Date.now();
    if (!s.queued) return null;
    const out = Buffer.concat(s.queue, s.queued);
    s.queue = [];
    s.queued = 0;
    return out;
}

export function stopCapture(_: IpcMainInvokeEvent, id: number) {
    stopSession(id);
}

export function getDebug(_: IpcMainInvokeEvent) {
    return lastDebug;
}
