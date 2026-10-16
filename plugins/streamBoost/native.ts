/*
 * StreamBoost (native / proceso principal de Vesktop)
 * Guarda un diagnóstico de la GPU (qué codificadores de video por hardware ve Chromium)
 * en streamBoost-gpu.json, junto a los archivos de Vencord.
 */

import { app, IpcMainInvokeEvent } from "electron";
import { writeFileSync } from "fs";
import { join } from "path";

const OUT = join(__dirname, "streamBoost-gpu.json");

async function collect() {
    const info: Record<string, any> = {
        fecha: new Date().toISOString(),
        versions: { electron: process.versions.electron, chrome: process.versions.chrome },
        switches: {
            "enable-features": app.commandLine.getSwitchValue("enable-features"),
            "disable-features": app.commandLine.getSwitchValue("disable-features"),
            "disable-gpu": app.commandLine.hasSwitch("disable-gpu"),
            argv: process.argv.slice(1)
        }
    };
    try { info.featureStatus = app.getGPUFeatureStatus(); } catch (e) { info.featureStatusError = String(e); }
    try { info.gpuBasic = await app.getGPUInfo("basic"); } catch (e) { info.gpuBasicError = String(e); }
    try { info.gpuComplete = await app.getGPUInfo("complete"); } catch (e) { info.gpuCompleteError = String(e); }
    return info;
}

let last: any = null;
async function save() {
    try {
        last = await collect();
        writeFileSync(OUT, JSON.stringify(last, null, 2));
    } catch (e) { last = { error: String(e) }; }
    return last;
}

// Se guarda solo, unos segundos después de abrir Vesktop (cuando la GPU ya está inicializada)
app.whenReady().then(() => setTimeout(save, 15000));

export function gpuDiagnostics(_: IpcMainInvokeEvent) {
    return save();
}
