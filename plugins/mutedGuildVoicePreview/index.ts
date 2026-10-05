/*
 * MutedGuildVoicePreview — en los servidores silenciados (muted), el tooltip de la lista de
 * servidores solo dice "Muted". Este plugin añade igualmente la vista previa de quién está
 * en voice y quién está transmitiendo, como en los servidores no silenciados.
 */

import definePlugin from "@utils/types";
import { ChannelStore, GuildStore, PermissionsBits, PermissionStore, UserGuildSettingsStore, UserStore, VoiceStateStore } from "@webpack/common";

const BLOCK_CLASS = "vc-mgvp";
const STYLE_ID = "vc-mgvp-style";
const MAX_AVATARS = 6;

// Iconos de respaldo. En cuanto Discord muestra su tooltip normal (servidor no silenciado con gente
// en voice), el plugin guarda los iconos que dibuja Discord y usa esos mismos, idénticos.
const SPEAKER = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 9h3.5L11 4.5v15L6.5 15H3z"/><path d="M14 8.6a4.5 4.5 0 0 1 0 6.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M16.6 5.8a8.3 8.3 0 0 1 0 12.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
const SCREEN = `<svg viewBox="0 0 24 24" width="20" height="20"><rect x="2" y="3" width="20" height="13" rx="3" fill="currentColor"/><path d="M11 20h2v-4h-2z" fill="currentColor"/><rect x="8" y="19.5" width="8" height="1.8" rx=".9" fill="currentColor"/><path d="M7.5 13.5c.6-3 2.8-4.6 6-4.6" fill="none" stroke="#111214" stroke-width="1.9" stroke-linecap="round"/><path d="M12.6 6.6l3 2.3-3 2.3z" fill="#111214"/></svg>`;

const CSS = `
.${BLOCK_CLASS} { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; flex-basis: 100%; width: 100%; }
.${BLOCK_CLASS} .vc-mgvp-row { display: flex; align-items: center; gap: 8px; color: var(--interactive-normal, #b5bac1); }
.${BLOCK_CLASS} .vc-mgvp-row > svg { width: 20px; height: 20px; flex: none; }
.${BLOCK_CLASS} .vc-mgvp-avatars { display: flex; }
.${BLOCK_CLASS} .vc-mgvp-avatars img {
    width: 24px; height: 24px; border-radius: 50%;
    box-shadow: 0 0 0 2px var(--background-floating, #111214);
    margin-left: -4px; background: #444;
}
.${BLOCK_CLASS} .vc-mgvp-avatars img:first-child { margin-left: 0; }
.${BLOCK_CLASS} .vc-mgvp-more { margin-left: 6px; font-size: 12px; font-weight: 600; color: var(--text-normal, #dbdee1); }
`;

const CACHE_KEY = "vc-mgvp-icons";
let iconCache: { speaker?: string; screen?: string; } = {};
try { iconCache = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}"); } catch { }

function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(iconCache)); } catch { }
}

/** Toma los iconos de las filas de voice/stream de un tooltip normal de Discord. */
function learnIcons(tip: HTMLElement, guildName: string, hasVoice: boolean, hasStream: boolean) {
    const rows: Element[] = [];
    for (const svg of Array.from(tip.querySelectorAll("svg"))) {
        if (svg.closest(`.${BLOCK_CLASS}`)) continue;
        // la fila es el ancestro más cercano que también contiene avatares
        let row: Element | null = svg.parentElement;
        while (row && row !== tip && !row.querySelector("img")) row = row.parentElement;
        if (!row || row === tip || row.textContent?.includes(guildName)) continue;
        if (!rows.includes(row) && row.querySelector("svg") === svg) rows.push(row);
    }
    const first = (r?: Element) => r?.querySelector("svg")?.outerHTML;
    let changed = false;
    if (hasVoice && hasStream && rows.length >= 2) {
        iconCache.speaker = first(rows[0]); iconCache.screen = first(rows[1]); changed = true;
    } else if (hasVoice && !hasStream && rows.length === 1) {
        iconCache.speaker = first(rows[0]); changed = true;
    } else if (hasStream && !hasVoice && rows.length === 1) {
        iconCache.screen = first(rows[0]); changed = true;
    }
    if (changed) saveCache();
}

interface VS { userId: string; channelId?: string | null; selfStream?: boolean; }

function voiceUsers(guildId: string) {
    const states = VoiceStateStore.getVoiceStates(guildId) ?? {};
    const voice: string[] = [], streaming: string[] = [];
    for (const vs of Object.values(states) as VS[]) {
        if (!vs?.channelId) continue;
        const ch = ChannelStore.getChannel(vs.channelId);
        if (!ch || !PermissionStore.can(PermissionsBits.VIEW_CHANNEL, ch)) continue;
        // Igual que Discord: la fila de voice lleva a todos, la de stream solo a quien transmite
        voice.push(vs.userId);
        if (vs.selfStream) streaming.push(vs.userId);
    }
    return { voice, streaming };
}

function makeRow(doc: Document, icon: string, ids: string[], guildId: string) {
    const row = doc.createElement("div");
    row.className = "vc-mgvp-row";
    row.innerHTML = icon;
    const avatars = doc.createElement("div");
    avatars.className = "vc-mgvp-avatars";
    for (const id of ids.slice(0, MAX_AVATARS)) {
        const u = UserStore.getUser(id);
        const img = doc.createElement("img");
        try { img.src = u?.getAvatarURL(guildId, 32) ?? ""; } catch { }
        img.alt = "";
        avatars.appendChild(img);
    }
    row.appendChild(avatars);
    if (ids.length > MAX_AVATARS) {
        const more = doc.createElement("span");
        more.className = "vc-mgvp-more";
        more.textContent = `+${ids.length - MAX_AVATARS}`;
        row.appendChild(more);
    }
    return row;
}

let hoveredGuild: string | null = null;
let observer: MutationObserver | null = null;

function onMouseOver(e: MouseEvent) {
    const item = (e.target as Element)?.closest?.('[data-list-item-id^="guildsnav___"]');
    const id = item?.getAttribute("data-list-item-id")?.slice("guildsnav___".length);
    hoveredGuild = id && /^\d+$/.test(id) ? id : null;
    if (hoveredGuild) setTimeout(decorate, 50);
}

function findTooltipNameEl(name: string): { tip: HTMLElement; nameEl: HTMLElement; } | null {
    // El tooltip del servidor contiene el nombre exacto del servidor
    const tips = document.querySelectorAll<HTMLElement>('[role="tooltip"], [class*="tooltip"]');
    for (const tip of Array.from(tips).reverse()) {
        const walker = document.createTreeWalker(tip, NodeFilter.SHOW_TEXT);
        let n: Node | null;
        while ((n = walker.nextNode())) {
            if (n.textContent?.trim() === name.trim() && n.parentElement) return { tip, nameEl: n.parentElement };
        }
    }
    return null;
}

function decorate() {
    const guildId = hoveredGuild;
    if (!guildId) return;
    const guild = GuildStore.getGuild(guildId);
    if (!guild) return;

    const found = findTooltipNameEl(guild.name);
    if (!found) return;

    if (!UserGuildSettingsStore.isMuted(guildId)) {
        // Servidor normal: aprender los iconos originales de Discord de su tooltip
        if (!iconCache.speaker || !iconCache.screen) {
            const { voice, streaming } = voiceUsers(guildId);
            if (voice.length || streaming.length) learnIcons(found.tip, guild.name, voice.length > 0, streaming.length > 0);
        }
        return;
    }
    // Ponerlo debajo de todo el contenido del tooltip (no dentro de la fila del nombre)
    const container = found.nameEl.closest<HTMLElement>('[class*="tooltipContent"], [class*="content"]') ?? found.tip;
    if (container.querySelector(`.${BLOCK_CLASS}`)) return;

    const { voice, streaming } = voiceUsers(guildId);
    if (!voice.length && !streaming.length) return;

    const block = document.createElement("div");
    block.className = BLOCK_CLASS;
    if (voice.length) block.appendChild(makeRow(document, iconCache.speaker ?? SPEAKER, voice, guildId));
    if (streaming.length) block.appendChild(makeRow(document, iconCache.screen ?? SCREEN, streaming, guildId));
    container.appendChild(block);
}

export default definePlugin({
    name: "MutedGuildVoicePreview",
    description: "Muestra quién está en voice (y transmitiendo) en el tooltip de los servidores silenciados.",
    authors: [{ name: "Richardant", id: 0n }],

    start() {
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);

        document.addEventListener("mouseover", onMouseOver, true);
        // Los tooltips aparecen después del hover; decoramos cuando se añaden al DOM
        observer = new MutationObserver(() => { if (hoveredGuild) decorate(); });
        observer.observe(document.body, { childList: true, subtree: true });
    },

    stop() {
        document.removeEventListener("mouseover", onMouseOver, true);
        observer?.disconnect();
        observer = null;
        document.getElementById(STYLE_ID)?.remove();
        document.querySelectorAll(`.${BLOCK_CLASS}`).forEach(e => e.remove());
        hoveredGuild = null;
    }
});
