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

const SPEAKER = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 3a1 1 0 0 0-1.7-.7L6.6 6H4a2 2 0 0 0-2 2v8c0 1.1.9 2 2 2h2.6l3.7 3.7A1 1 0 0 0 12 21V3Z"/><path d="M15.2 7.4a1 1 0 0 1 1.4.2 7 7 0 0 1 0 8.8 1 1 0 1 1-1.6-1.2 5 5 0 0 0 0-6.4 1 1 0 0 1 .2-1.4Z"/></svg>`;
const SCREEN = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 3a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h16a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4Z"/><path d="M8 20h8v1.5H8z"/></svg>`;

const CSS = `
.${BLOCK_CLASS} { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; flex-basis: 100%; width: 100%; }
.${BLOCK_CLASS} .vc-mgvp-row { display: flex; align-items: center; gap: 8px; color: var(--interactive-normal, #b5bac1); }
.${BLOCK_CLASS} .vc-mgvp-avatars { display: flex; }
.${BLOCK_CLASS} .vc-mgvp-avatars img {
    width: 24px; height: 24px; border-radius: 50%;
    box-shadow: 0 0 0 2px var(--background-floating, #111214);
    margin-left: -4px; background: #444;
}
.${BLOCK_CLASS} .vc-mgvp-avatars img:first-child { margin-left: 0; }
.${BLOCK_CLASS} .vc-mgvp-more { margin-left: 6px; font-size: 12px; font-weight: 600; color: var(--text-normal, #dbdee1); }
`;

interface VS { userId: string; channelId?: string | null; selfStream?: boolean; }

function voiceUsers(guildId: string) {
    const states = VoiceStateStore.getVoiceStates(guildId) ?? {};
    const voice: string[] = [], streaming: string[] = [];
    for (const vs of Object.values(states) as VS[]) {
        if (!vs?.channelId) continue;
        const ch = ChannelStore.getChannel(vs.channelId);
        if (!ch || !PermissionStore.can(PermissionsBits.VIEW_CHANNEL, ch)) continue;
        (vs.selfStream ? streaming : voice).push(vs.userId);
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
    if (!guildId || !UserGuildSettingsStore.isMuted(guildId)) return;
    const guild = GuildStore.getGuild(guildId);
    if (!guild) return;

    const found = findTooltipNameEl(guild.name);
    if (!found) return;
    // Ponerlo debajo de todo el contenido del tooltip (no dentro de la fila del nombre)
    const container = found.nameEl.closest<HTMLElement>('[class*="tooltipContent"], [class*="content"]') ?? found.tip;
    if (container.querySelector(`.${BLOCK_CLASS}`)) return;

    const { voice, streaming } = voiceUsers(guildId);
    if (!voice.length && !streaming.length) return;

    const block = document.createElement("div");
    block.className = BLOCK_CLASS;
    if (voice.length) block.appendChild(makeRow(document, SPEAKER, voice, guildId));
    if (streaming.length) block.appendChild(makeRow(document, SCREEN, streaming, guildId));
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
