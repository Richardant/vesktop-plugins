/*
 * TikTokLive (native / proceso principal de Vesktop)
 *
 * - Detecta si TikTok LIVE Studio está abierto (lista de procesos de Windows con tasklist).
 * - Consulta a TikTok si tu cuenta está en vivo (título, espectadores, hora de inicio).
 *   Se hace desde aquí con la red de Chromium para que TikTok lo vea como un navegador normal.
 */

import { execFile } from "child_process";
import { IpcMainInvokeEvent, net } from "electron";

export function studioRunning(_: IpcMainInvokeEvent): Promise<boolean> {
    if (process.platform !== "win32") return Promise.resolve(false);
    return new Promise(resolve => {
        execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
            if (err) return resolve(false);
            resolve(/tiktok\s*live\s*studio/i.test(String(stdout)));
        });
    });
}

export interface LiveInfo {
    ok: boolean;
    live?: boolean;
    title?: string;
    viewers?: number;
    startTime?: number;
    nickname?: string;
    cover?: string;
    error?: string;
}

export async function checkLive(_: IpcMainInvokeEvent, username: string): Promise<LiveInfo> {
    const user = String(username ?? "").trim().replace(/^@/, "");
    if (!user) return { ok: false, error: "sin usuario" };
    try {
        const url = `https://www.tiktok.com/api-live/user/room/?aid=1988&uniqueId=${encodeURIComponent(user)}&sourceType=54`;
        const res = await net.fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
                "Accept": "application/json, text/plain, */*",
                "Referer": `https://www.tiktok.com/@${user}/live`
            }
        });
        if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
        const j: any = await res.json();
        const room = j?.data?.liveRoom;
        const u = j?.data?.user;
        if (!room && !u) return { ok: false, error: `respuesta sin datos (${j?.statusCode})` };
        // status 2 = en vivo; 4 = terminado
        const status = room?.status ?? u?.status;
        return {
            ok: true,
            live: status === 2,
            title: room?.title || undefined,
            viewers: room?.liveRoomStats?.userCount,
            startTime: room?.startTime ? room.startTime * 1000 : undefined,
            nickname: u?.nickname,
            cover: room?.coverUrl?.url_list?.[0] || u?.avatarLarger || undefined
        };
    } catch (e) {
        return { ok: false, error: String(e) };
    }
}
