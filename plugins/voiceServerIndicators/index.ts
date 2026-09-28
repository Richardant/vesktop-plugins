/*
 * VoiceServerIndicators — muestra en la lista de servidores un icono cuando
 * hay gente en voice (altavoz) o alguien está streameando (monitor),
 * igual que la app oficial de Discord.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelStore, PermissionsBits, PermissionStore, UserStore, VoiceStateStore } from "@webpack/common";

const BADGE_CLASS = "vc-vsi-badge";
const STYLE_ID = "vc-vsi-style";

// Iconos redibujados sobre una rejilla de 16x16 para calcar el badge oficial (medido en capturas).
const ICON_SPEAKER = `<svg viewBox="0 0 16 16" width="100%" height="100%" fill="currentColor"><g transform="translate(7.6 8) scale(1.25) translate(-7.6 -8)"><path d="M3.6 6.4h1.9L8 4v8L5.5 9.6H3.6a.5.5 0 0 1-.5-.5V6.9a.5.5 0 0 1 .5-.5Z"/><path d="M9.3 6.3a2.3 2.3 0 0 1 0 3.4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><path d="M10.6 4.9a4.3 4.3 0 0 1 0 6.2" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></g></svg>`;
const ICON_SCREEN = `<svg viewBox="0 0 16 16" width="100%" height="100%" fill="currentColor"><rect x="3" y="3.2" width="10" height="6.8" rx="1.2"/><rect x="7.1" y="10" width="1.8" height="1.9"/><rect x="5.9" y="11.7" width="4.2" height="1.2" rx=".6"/></svg>`;

const settings = definePluginSettings({
    ignoreSelf: {
        type: OptionType.BOOLEAN,
        description: "No mostrar el icono si el único en voice eres tú",
        default: false
    },
    onlyVisibleChannels: {
        type: OptionType.BOOLEAN,
        description: "Contar solo canales que puedes ver (como Discord oficial)",
        default: true
    }
});

type Status = "stream" | "voice" | null;

interface VS { userId: string; channelId?: string | null; selfStream?: boolean; }

function getGuildStatus(guildId: string): Status {
    const states = VoiceStateStore.getVoiceStates(guildId);
    if (!states) return null;

    const myId = UserStore.getCurrentUser()?.id;
    let hasVoice = false;

    for (const vs of Object.values(states) as VS[]) {
        if (!vs?.channelId) continue;
        if (settings.store.ignoreSelf && vs.userId === myId) continue;
        if (settings.store.onlyVisibleChannels) {
            const ch = ChannelStore.getChannel(vs.channelId);
            if (!ch || !PermissionStore.can(PermissionsBits.VIEW_CHANNEL, ch)) continue;
        }
        if (vs.selfStream) return "stream";
        hasVoice = true;
    }
    return hasVoice ? "voice" : null;
}

let bgDetected = false;
function detectBackground(from: HTMLElement) {
    if (bgDetected) return;
    let el: HTMLElement | null = from;
    while (el) {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg)) {
            document.documentElement.style.setProperty("--vsi-bg", bg);
            bgDetected = true;
            return;
        }
        el = el.parentElement;
    }
}

function render() {
    const items = document.querySelectorAll<HTMLElement>('[data-list-item-id^="guildsnav___"]');
    for (const item of items) {
        const guildId = item.getAttribute("data-list-item-id")!.slice("guildsnav___".length);
        if (!/^\d+$/.test(guildId)) continue; // home, carpetas, "añadir servidor", etc.

        // El icono del servidor está dentro de un <svg> con máscara (esquinas redondeadas).
        // Ponemos el badge FUERA de ese svg para que quede encima como overlay y no se recorte.
        const svg = item.closest("svg");
        const host = (svg?.parentElement ?? item.parentElement) as HTMLElement | null;
        if (!host) continue;
        detectBackground(host);

        const status = getGuildStatus(guildId);
        let badge = host.querySelector<HTMLElement>(`:scope > .${BADGE_CLASS}`);

        if (!status) {
            badge?.remove();
            continue;
        }

        if (!badge) {
            badge = document.createElement("div");
            badge.className = BADGE_CLASS;
            if (getComputedStyle(host).position === "static") host.style.position = "relative";
            host.appendChild(badge);
        }
        // tamaño proporcional al icono del servidor (oficial: círculo = 40% del icono, borde = 5%)
        const w = host.getBoundingClientRect().width || 48;
        const size = Math.round(w * 0.4);
        const ring = Math.max(1, Math.round(w * 0.05));
        if (badge.dataset.size !== `${size}:${ring}`) {
            badge.dataset.size = `${size}:${ring}`;
            badge.style.width = badge.style.height = `${size}px`;
            badge.style.boxShadow = `0 0 0 ${ring}px var(--vsi-bg, #000)`;
        }
        if (badge.dataset.status !== status) {
            badge.dataset.status = status;
            badge.innerHTML = status === "stream" ? ICON_SCREEN : ICON_SPEAKER;
        }
    }
}

let raf = 0;
function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
        raf = 0;
        try { render(); } catch (e) { console.error("[VoiceServerIndicators]", e); }
    });
}

let observer: MutationObserver | null = null;

export default definePlugin({
    name: "VoiceServerIndicators",
    description: "Muestra un icono de altavoz/pantalla sobre los servidores con gente en voice o streameando (como la app oficial).",
    authors: [{ name: "Richardant", id: 0n }],
    settings,

    start() {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
.${BADGE_CLASS} {
    position: absolute;
    top: 0;
    right: 0;
    width: 16px;
    height: 16px;
    box-sizing: border-box;
    border-radius: 50%;
    background: #1c1c1c;
    color: #fff;
    display: flex;
    align-items: stretch;
    justify-content: stretch;
    pointer-events: none;
    z-index: 2;
    box-shadow: 0 0 0 2px var(--vsi-bg, #000);
}
.${BADGE_CLASS} svg { display: block; width: 100%; height: 100%; }
`;
        document.head.appendChild(style);

        VoiceStateStore.addChangeListener(scheduleRender);
        PermissionStore.addChangeListener(scheduleRender);

        // la lista de servidores es virtualizada: re-dibujar cuando cambian nodos
        observer = new MutationObserver(scheduleRender);
        observer.observe(document.body, { childList: true, subtree: true });

        scheduleRender();
    },

    stop() {
        VoiceStateStore.removeChangeListener(scheduleRender);
        PermissionStore.removeChangeListener(scheduleRender);
        observer?.disconnect();
        observer = null;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        document.getElementById(STYLE_ID)?.remove();
        document.documentElement.style.removeProperty("--vsi-bg");
        bgDetected = false;
        document.querySelectorAll(`.${BADGE_CLASS}`).forEach(e => e.remove());
    }
});
