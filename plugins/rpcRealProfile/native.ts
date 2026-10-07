/*
 * RpcRealProfile (native / proceso principal de Vesktop)
 *
 * El servidor RPC integrado de Vesktop (arRPC) responde a los juegos con un usuario falso
 * ("arRPC" y su logo). Aquí envolvemos el Worker de arRPC para que, al conectarse un juego
 * (RuneLite, etc.), reciba tu usuario real de Discord: id, nombre y foto de perfil.
 */

import { IpcMainInvokeEvent } from "electron";
import { readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

// require directo (no import *) para modificar el objeto real del módulo que usa Vesktop
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wt = require("worker_threads") as typeof import("worker_threads");

const CACHE = join(__dirname, "rpcRealProfile.json");
let user: Record<string, any> | null = null;
try { user = JSON.parse(readFileSync(CACHE, "utf8")); } catch { }

const ports = new Set<import("worker_threads").MessagePort>();

// Código que corre DENTRO del worker de arRPC antes que arRPC.
const workerPrelude = (file: string) => `
const wt = require("worker_threads");
const net = require("net");
const MOCK = "1045800378228281345";
let user = (wt.workerData && wt.workerData.__vcRpcUser) || null;
const port = wt.workerData && wt.workerData.__vcRpcPort;
if (port) { port.on("message", u => { user = u; }); port.unref(); }
const origWrite = net.Socket.prototype.write;
net.Socket.prototype.write = function (chunk, ...rest) {
    try {
        if (user && Buffer.isBuffer(chunk) && chunk.length > 8 && chunk.readInt32LE(0) === 1 && chunk.readInt32LE(4) === chunk.length - 8) {
            const s = chunk.toString("utf8", 8);
            if (s.includes(MOCK)) {
                const m = JSON.parse(s);
                if (m.evt === "READY" && m.data && m.data.user && m.data.user.id === MOCK) {
                    m.data.user = Object.assign({}, m.data.user, user);
                    const d = Buffer.from(JSON.stringify(m));
                    const b = Buffer.alloc(d.length + 8);
                    b.writeInt32LE(1, 0); b.writeInt32LE(d.length, 4); d.copy(b, 8);
                    chunk = b;
                }
            }
        }
    } catch (e) { }
    return origWrite.call(this, chunk, ...rest);
};
require(${JSON.stringify(file)});
`;

const OrigWorker = wt.Worker;
if (!(OrigWorker as any).__vcRpcPatched) {
    class PatchedWorker extends OrigWorker {
        constructor(filename: string | URL, options: any = {}) {
            const file = typeof filename === "string" ? filename : filename.pathname;
            if (!options.eval && /arRpcWorker\.js$/i.test(file)) {
                const { port1, port2 } = new wt.MessageChannel();
                ports.add(port1);
                port1.unref();
                super(workerPrelude(resolve(file)), {
                    ...options,
                    eval: true,
                    workerData: { ...(options.workerData ?? {}), __vcRpcUser: user, __vcRpcPort: port2 },
                    transferList: [...(options.transferList ?? []), port2]
                });
                this.once("exit", () => ports.delete(port1));
                return;
            }
            super(filename, options);
        }
    }
    (PatchedWorker as any).__vcRpcPatched = true;
    wt.Worker = PatchedWorker as any;
}

export function setUser(_: IpcMainInvokeEvent, u: Record<string, any>) {
    if (!u?.id) return;
    user = u;
    try { writeFileSync(CACHE, JSON.stringify(u)); } catch { }
    for (const p of ports) p.postMessage(u);
}

export function status(_: IpcMainInvokeEvent) {
    return { workers: ports.size, user: user?.username ?? null };
}
