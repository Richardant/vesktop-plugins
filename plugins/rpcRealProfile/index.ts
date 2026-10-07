/*
 * RpcRealProfile — los juegos conectados por RPC (RuneLite Party, etc.) ven tu
 * usuario real de Discord (nombre y foto de perfil) en vez del usuario "arRPC" de Vesktop.
 */

import definePlugin, { PluginNative } from "@utils/types";
import { UserStore } from "@webpack/common";

const Native = VencordNative.pluginHelpers.RpcRealProfile as PluginNative<typeof import("./native")>;

let last = "";
function sync() {
    const u: any = UserStore.getCurrentUser();
    if (!u?.id) return;
    const data = {
        id: u.id,
        username: u.username,
        discriminator: u.discriminator ?? "0",
        global_name: u.globalName ?? u.global_name ?? null,
        avatar: u.avatar ?? null,
        avatar_decoration_data: null,
        bot: false,
        flags: u.publicFlags ?? 0,
        premium_type: u.premiumType ?? 0
    };
    const key = JSON.stringify(data);
    if (key === last) return;
    last = key;
    void Native.setUser(data);
}

export default definePlugin({
    name: "RpcRealProfile",
    description: "Los juegos con integración de Discord (RuneLite Party, etc.) ven tu usuario y foto de perfil reales en vez de \"arRPC\".",
    authors: [{ name: "Richardant", id: 0n }],

    start() {
        sync();
        UserStore.addChangeListener(sync);
    },

    stop() {
        UserStore.removeChangeListener(sync);
    }
});
