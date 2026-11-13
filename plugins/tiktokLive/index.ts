/*
 * TikTokLive — muestra en tu perfil de Discord que estás en vivo en TikTok,
 * como hace Discord con Twitch.
 *
 * Revisa si tu cuenta está en vivo (cada 30 s con TikTok LIVE Studio abierto, si no cada minuto).
 * Si lo está, pone una actividad "TikTok LIVE" con el título del directo, los espectadores,
 * el tiempo en vivo y un botón "Ver en vivo" (los demás ven el botón; Discord oculta
 * los botones de tu propia actividad solo para ti).
 */

import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { ApplicationAssetUtils, FluxDispatcher } from "@webpack/common";

const Native = VencordNative.pluginHelpers.TikTokLive as PluginNative<typeof import("./native")>;
const logger = new Logger("TikTokLive");
const SOCKET = "TikTokLive";
// Logo de TikTok (paquete abierto de íconos "dashboard-icons", servido por jsDelivr)
const TIKTOK_LOGO = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/tiktok.png";

const settings = definePluginSettings({
    username: {
        type: OptionType.STRING,
        description: "Tu usuario de TikTok (sin @)",
        default: "Richardant_",
        onChange: () => void refresh(true)
    },
    showViewers: {
        type: OptionType.BOOLEAN,
        description: "Mostrar cuántos espectadores tienes",
        default: true,
        onChange: () => void refresh(true)
    },
    appId: {
        type: OptionType.STRING,
        description: "ID de una aplicación tuya de Discord (discord.com/developers/applications → New Application → copiar Application ID). Hace falta para mostrar el logo de TikTok; vacío = sin imagen",
        default: "",
        onChange: () => void refresh(true)
    }
});

let timer: ReturnType<typeof setInterval> | null = null;
let lastCheck = 0;
let lastInfo: { live: boolean; title?: string; viewers?: number; startTime?: number; cover?: string; } | null = null;
let shown = false;
let busy = false;

function liveUrl() {
    return `https://www.tiktok.com/@${settings.store.username.trim().replace(/^@/, "").toLowerCase()}/live`;
}

const assetCache = new Map<string, string>();
async function imageFor(appId: string, url: string) {
    const key = appId + "|" + url;
    if (assetCache.has(key)) return assetCache.get(key);
    try {
        const id = (await ApplicationAssetUtils.fetchAssetIds(appId, [url]))[0];
        if (id) assetCache.set(key, id);
        return id;
    } catch (e) {
        logger.warn("No se pudo preparar la imagen", url, e);
        return undefined;
    }
}

async function setActivity(info: { title?: string; viewers?: number; startTime?: number; cover?: string; }) {
    const appId = settings.store.appId.trim();
    const activity: any = {
        application_id: appId || "0",
        name: "TikTok LIVE",
        type: 0,
        flags: 1,
        details: info.title || "🔴 En vivo en TikTok",
        state: settings.store.showViewers && info.viewers != null
            ? `🔴 En vivo · ${info.viewers} ${info.viewers === 1 ? "espectador" : "espectadores"}`
            : "🔴 En vivo ahora",
        timestamps: { start: info.startTime ?? Date.now() },
        buttons: ["Ver en vivo"],
        metadata: { button_urls: [liveUrl()] }
    };
    if (appId) {
        const [logo, cover] = await Promise.all([
            imageFor(appId, TIKTOK_LOGO),
            info.cover ? imageFor(appId, info.cover) : Promise.resolve(undefined)
        ]);
        if (logo) activity.assets = { large_image: logo, large_text: "TikTok LIVE" };
        if (logo && cover) Object.assign(activity.assets, { small_image: cover, small_text: info.title || "En vivo" });
    }
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity, socketId: SOCKET });
    shown = true;
}

function clearActivity() {
    if (!shown) return;
    FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", activity: null, socketId: SOCKET });
    shown = false;
}

async function refresh(force = false) {
    if (busy) return;
    busy = true;
    try {
        const studio = await Native.studioRunning();
        const now = Date.now();
        // Con LIVE Studio abierto revisamos cada 30 s; si no, cada minuto (por si transmites
        // desde el celular u OBS, o si LIVE Studio usa otro nombre de proceso).
        const interval = studio ? 30_000 : 60_000;
        if (!force && now - lastCheck < interval) return;
        lastCheck = now;

        const r = await Native.checkLive(settings.store.username);
        if (r.ok) {
            lastInfo = { live: !!r.live, title: r.title, viewers: r.viewers, startTime: r.startTime, cover: r.cover };
        } else {
            logger.warn("No se pudo consultar TikTok:", r.error);
            // Si TikTok no responde pero LIVE Studio está abierto, asumimos que sigues en vivo
            // (o que estás por empezar) y mantenemos lo último que sabíamos.
            if (!lastInfo) lastInfo = studio ? { live: true } : { live: false };
        }

        if (lastInfo.live) await setActivity(lastInfo);
        else clearActivity();
    } catch (e) {
        logger.error(e);
    } finally {
        busy = false;
    }
}

export default definePlugin({
    name: "TikTokLive",
    description: "Muestra en tu perfil de Discord que estás en vivo en TikTok (título, espectadores y botón \"Ver en vivo\"), como Discord hace con Twitch.",
    authors: [{ name: "Richardant", id: 0n }],
    settings,

    start() {
        setTimeout(() => void refresh(true), 5000);
        timer = setInterval(() => void refresh(), 10_000);
    },

    stop() {
        if (timer) clearInterval(timer);
        timer = null;
        lastInfo = null;
        clearActivity();
    }
});
