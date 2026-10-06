/*
 * CategoryPriorityNotifications — eliges categorías (clic derecho → "Notificaciones prioritarias")
 * y recibes notificación de CUALQUIER mensaje en sus canales (e hilos), aunque el servidor,
 * la categoría o el canal estén silenciados, o estén en "solo @menciones" / "nada".
 */

import { addGlobalContextMenuPatch, findGroupChildrenByChildId, GlobalContextMenuPatchCallback, removeGlobalContextMenuPatch } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { filters, find } from "@webpack";
import { Button, ChannelStore, GuildRoleStore, GuildStore, Menu, NavigationRouter, RelationshipStore, SelectedChannelStore, UserGuildSettingsStore, UserStore, useState } from "@webpack/common";

const logger = new Logger("CategoryPriorityNotifications");
const CATEGORY = 4;
const MSG_TYPES = new Set([0, 19, 20, 21]); // normal, respuesta, comando, inicio de hilo

const settings = definePluginSettings({
    categories: {
        type: OptionType.CUSTOM,
        default: {} as Record<string, string>, // categoryId -> guildId
    },
    list: {
        type: OptionType.COMPONENT,
        description: "Categorías prioritarias",
        component: () => <CategoryList />
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Ignorar mensajes de bots",
        default: false
    },
    skipCurrentChannel: {
        type: OptionType.BOOLEAN,
        description: "No notificar si ya estás viendo ese canal con la ventana activa",
        default: true
    },
    sound: {
        type: OptionType.BOOLEAN,
        description: "Reproducir sonido",
        default: true
    },
    persistent: {
        type: OptionType.BOOLEAN,
        description: "La notificación de Windows no se cierra sola hasta que la toques",
        default: false
    }
});

function CategoryList() {
    const [, rerender] = useState(0);
    const entries = Object.entries(settings.store.categories ?? {});
    if (!entries.length)
        return <div style={{ color: "var(--text-muted)" }}>Ninguna todavía. Clic derecho sobre una categoría → "Notificaciones prioritarias".</div>;

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {entries.map(([catId, guildId]) => {
                const cat = ChannelStore.getChannel(catId);
                const guild = GuildStore.getGuild(guildId);
                return (
                    <div key={catId} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, color: "var(--text-normal)" }}>
                        <span>{guild?.name ?? "Servidor desconocido"} › <b>{cat?.name ?? catId}</b></span>
                        <Button size={Button.Sizes.SMALL} color={Button.Colors.RED} onClick={() => { toggle(catId, guildId); rerender(x => x + 1); }}>Quitar</Button>
                    </div>
                );
            })}
        </div>
    );
}

function isSelected(catId: string) {
    return !!settings.store.categories?.[catId];
}

function toggle(catId: string, guildId: string) {
    const next = { ...(settings.store.categories ?? {}) };
    if (next[catId]) delete next[catId];
    else next[catId] = guildId;
    settings.store.categories = next;
}

const contextPatch: GlobalContextMenuPatchCallback = (_navId, children, props) => {
    const channel = props?.channel;
    if (channel?.type !== CATEGORY || !channel.guild_id) return;
    if (findGroupChildrenByChildId("vc-cpn-toggle", children)) return;

    const item = (
        <Menu.MenuCheckboxItem
            id="vc-cpn-toggle"
            label="Notificaciones prioritarias"
            checked={isSelected(channel.id)}
            action={() => toggle(channel.id, channel.guild_id)}
        />
    );
    const group = findGroupChildrenByChildId(["mute-channel", "unmute-channel"], children);
    if (group) group.push(item);
    else children.push(<Menu.MenuGroup>{item}</Menu.MenuGroup>);
};

/** Categoría a la que pertenece un canal (o el canal padre de un hilo / post de foro). */
function categoryOf(channel: any): string | null {
    if (!channel) return null;
    if (channel.isThread?.() || [10, 11, 12].includes(channel.type)) {
        const parent = ChannelStore.getChannel(channel.parent_id);
        return parent?.parent_id ?? null;
    }
    return channel.parent_id ?? null;
}

// --- Detección de las notificaciones que Discord crea por su cuenta (para no duplicar) ---
const OrigNotification = window.Notification;
const recent: { t: number; text: string; }[] = [];
let ours = false;

const NotificationProxy = OrigNotification && new Proxy(OrigNotification, {
    construct(target, args: [string, NotificationOptions?]) {
        if (!ours) {
            recent.push({ t: Date.now(), text: `${args[0] ?? ""}\n${args[1]?.body ?? ""}` });
            while (recent.length > 30) recent.shift();
        }
        return Reflect.construct(target, args);
    }
});

function discordNotifiedSince(t: number, needles: string[]) {
    return recent.some(n => n.t >= t && needles.some(s => s && n.text.includes(s)));
}

function discordWouldNotify(channel: any, message: any) {
    try {
        const me = UserStore.getCurrentUser()?.id;
        const mentioned = message.mention_everyone || message.mentions?.some((u: any) => (u.id ?? u) === me);
        if (mentioned) return true;
        if (UserGuildSettingsStore.isGuildOrCategoryOrChannelMuted(channel.guild_id, channel.id)) return false;
        return UserGuildSettingsStore.allowAllMessages(channel);
    } catch {
        return false;
    }
}

// --- Sonido ---
let soundMod: any;
function playSound() {
    if (!settings.store.sound) return;
    try {
        soundMod ??= find(filters.byProps("playSound"), { isIndirect: true }) ?? false;
        if (soundMod?.playSound) return void soundMod.playSound("message1", 0.4);
    } catch (e) { logger.warn("playSound de Discord no disponible", e); }
    // Respaldo: campanita propia
    try {
        const ctx = new AudioContext();
        const g = ctx.createGain();
        g.connect(ctx.destination);
        [[880, 0], [1320, 0.09]].forEach(([f, d]) => {
            const o = ctx.createOscillator();
            o.type = "sine";
            o.frequency.value = f;
            o.connect(g);
            o.start(ctx.currentTime + d);
            o.stop(ctx.currentTime + d + 0.12);
        });
        g.gain.setValueAtTime(0.15, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        setTimeout(() => ctx.close(), 600);
    } catch { }
}

// --- Contenido ---
function displayName(user: any, guildId: string) {
    return user?.globalName ?? user?.global_name ?? user?.username ?? "Alguien";
}

function formatBody(message: any, guildId: string) {
    let text: string = message.content ?? "";
    text = text
        .replace(/<@!?(\d+)>/g, (_, id) => "@" + (displayName(UserStore.getUser(id), guildId) ?? id))
        .replace(/<#(\d+)>/g, (_, id) => "#" + (ChannelStore.getChannel(id)?.name ?? "canal"))
        .replace(/<@&(\d+)>/g, (_, id) => "@" + (GuildRoleStore.getRole(guildId, id)?.name ?? "rol"))
        .replace(/<a?:(\w+):\d+>/g, ":$1:");
    if (!text.trim()) {
        if (message.attachments?.length) text = `📎 ${message.attachments.length > 1 ? `${message.attachments.length} archivos` : message.attachments[0].filename ?? "Archivo adjunto"}`;
        else if (message.sticker_items?.length) text = `Sticker: ${message.sticker_items[0].name}`;
        else if (message.embeds?.length) text = message.embeds[0].title ?? message.embeds[0].description ?? "Contenido incrustado";
        else text = "Mensaje nuevo";
    }
    return text.length > 300 ? text.slice(0, 297) + "…" : text;
}

function avatarOf(author: any, guildId: string) {
    try {
        return UserStore.getUser(author.id)?.getAvatarURL?.(guildId, 128) ?? undefined;
    } catch { return undefined; }
}

function openMessage(guildId: string, channelId: string, messageId: string) {
    try { (window as any).VesktopNative?.win?.focus?.(); } catch { }
    window.focus();
    NavigationRouter.transitionTo(`/channels/${guildId}/${channelId}/${messageId}`);
}

function notify(channel: any, message: any) {
    const guild = GuildStore.getGuild(channel.guild_id);
    const author = message.author ?? {};
    const name = message.member?.nick ?? displayName(author, channel.guild_id);
    const where = channel.name ? `#${channel.name}` : "";
    const title = `${name} (${[where, guild?.name].filter(Boolean).join(", ")})`;
    const body = formatBody(message, channel.guild_id);
    const icon = avatarOf(author, channel.guild_id);
    const onClick = () => openMessage(channel.guild_id, channel.id, message.id);

    playSound();

    if (!document.hasFocus() && OrigNotification && OrigNotification.permission === "granted") {
        ours = true;
        try {
            const n = new OrigNotification(title, { body, icon, silent: true, tag: `vc-cpn-${message.id}`, requireInteraction: settings.store.persistent });
            n.onclick = () => { onClick(); n.close(); };
        } finally { ours = false; }
    } else {
        void showNotification({ title, body, icon, onClick });
    }
}

function onMessage({ message, optimistic }: { message: any; optimistic?: boolean; }) {
    if (optimistic || !message?.channel_id || !message.author) return;
    const cats = settings.store.categories;
    if (!cats || !Object.keys(cats).length) return;

    const channel = ChannelStore.getChannel(message.channel_id);
    if (!channel?.guild_id) return;
    const cat = categoryOf(channel);
    if (!cat || !cats[cat]) return;

    const me = UserStore.getCurrentUser()?.id;
    if (message.author.id === me) return;
    if (message.type != null && !MSG_TYPES.has(message.type)) return;
    if (settings.store.ignoreBots && message.author.bot) return;
    try { if (RelationshipStore.isBlocked(message.author.id)) return; } catch { }

    const focused = document.hasFocus();
    if (settings.store.skipCurrentChannel && focused && SelectedChannelStore.getChannelId() === channel.id) return;

    const discordHandles = discordWouldNotify(channel, message);
    if (focused) {
        // Con la ventana activa Discord solo suena; si ya lo hace él, no duplicamos.
        if (!discordHandles) notify(channel, message);
        return;
    }

    // Ventana en segundo plano: esperamos un momento por si Discord ya mostró la suya.
    const t = Date.now();
    const needles = [(message.content ?? "").slice(0, 40), message.author.username, message.author.global_name, message.member?.nick];
    setTimeout(() => {
        if (discordNotifiedSince(t - 50, needles)) return;
        notify(channel, message);
    }, discordHandles ? 1200 : 0);
}

export default definePlugin({
    name: "CategoryPriorityNotifications",
    description: "Elige categorías (clic derecho → Notificaciones prioritarias) y recibe notificación de todos sus mensajes, aunque el servidor o los canales estén silenciados.",
    authors: [{ name: "Richardant", id: 0n }],
    settings,

    flux: {
        MESSAGE_CREATE: onMessage
    },

    start() {
        if (NotificationProxy) window.Notification = NotificationProxy;
        addGlobalContextMenuPatch(contextPatch);
        if (OrigNotification && OrigNotification.permission === "default") void OrigNotification.requestPermission();
    },

    stop() {
        if (OrigNotification) window.Notification = OrigNotification;
        removeGlobalContextMenuPatch(contextPatch);
    }
});
