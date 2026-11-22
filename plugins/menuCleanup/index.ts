/*
 * MenuCleanup — ordena y limpia algunos menús de Discord.
 *
 * (Por dentro: quita las opciones "Eliminar amigo", "Bloquear" (esta última cuando la persona es
 *  tu amigo), "Ignorar" y "Reportar" (de usuarios) de todos los menús — clic derecho sobre un usuario, el "..." de la lista de amigos y
 *  el del perfil — y además bloquea las acciones en sí, por si se intentan desde otro lugar.
 *  Cancelar o ignorar solicitudes y desbloquear usuarios sigue funcionando.)
 */

import { addGlobalContextMenuPatch, GlobalContextMenuPatchCallback, removeGlobalContextMenuPatch } from "@api/ContextMenu";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { RelationshipStore } from "@webpack/common";

const RelationshipActions = findByPropsLazy("addRelationship", "removeRelationship");

const REMOVE_ID = /remove[-_ ]?friend/i;
const REMOVE_LABEL = /^(remove friend|eliminar amigo|eliminar de amigos|quitar amigo)$/i;
const BLOCK_ID = /^block(-user)?$/i;
const BLOCK_LABEL = /^(block|bloquear)$/i;
const IGNORE_ID = /^ignore(-user)?$/i;
const IGNORE_LABEL = /^(ignore|ignorar)$/i;
const REPORT_ID = /^(report|report-user|user-report)$/i;
const REPORT_LABEL = /^(report|report user|reportar|reportar usuario|denunciar|denunciar usuario)$/i;

function isFriend(id?: string | null) {
    try { return !!id && RelationshipStore.isFriend(id); } catch { return false; }
}

function matches(el: any, idRe: RegExp, labelRe: RegExp) {
    const p = el?.props;
    if (!p) return false;
    if (typeof p.id === "string" && idRe.test(p.id)) return true;
    return typeof p.label === "string" && labelRe.test(p.label.trim());
}

function shouldHide(el: any, targetId: string | null, userMenu: boolean) {
    if (matches(el, REMOVE_ID, REMOVE_LABEL)) return true;
    // "Ignorar" y "Reportar" en los menús de usuarios (no toca "Reportar mensaje")
    if (userMenu && (matches(el, IGNORE_ID, IGNORE_LABEL) || matches(el, REPORT_ID, REPORT_LABEL))) return true;
    // "Bloquear": se oculta si la persona es tu amigo (o si el menú no dice de quién es)
    return matches(el, BLOCK_ID, BLOCK_LABEL) && (!targetId || isFriend(targetId));
}

function strip(children: any[], targetId: string | null, userMenu: boolean) {
    for (let i = children.length - 1; i >= 0; i--) {
        const c = children[i];
        if (shouldHide(c, targetId, userMenu)) { children.splice(i, 1); continue; }
        const kids = c?.props?.children;
        if (Array.isArray(kids)) strip(kids, targetId, userMenu);
        else if (kids && shouldHide(kids, targetId, userMenu)) c.props.children = null;
    }
}

const menuPatch: GlobalContextMenuPatchCallback = (navId, children, props) => {
    try {
        const targetId = props?.user?.id ?? props?.userId ?? null;
        const userMenu = !!targetId || /user|friend|profile/i.test(String(navId));
        strip(children, targetId, userMenu);
    } catch { }
};

// Bloqueo de las acciones en sí (por si se intentan desde un botón que no es un menú)
let origAdd: any = null;
let origRemove: any = null;

function wrapActions() {
    try {
        const RA = RelationshipActions;
        if (!RA || origAdd) return;
        origAdd = RA.addRelationship;
        origRemove = RA.removeRelationship;
        RA.addRelationship = function (this: any, arg: any, ...rest: any[]) {
            const uid = typeof arg === "object" ? arg?.userId : arg;
            const type = typeof arg === "object" ? arg?.type : rest[1];
            if (type === 2 && isFriend(uid)) return Promise.resolve(); // 2 = bloquear
            return origAdd.call(this, arg, ...rest);
        };
        RA.removeRelationship = function (this: any, uid: any, ...rest: any[]) {
            if (isFriend(uid)) return Promise.resolve();
            return origRemove.call(this, uid, ...rest);
        };
    } catch { }
}

function unwrapActions() {
    try {
        if (origAdd) RelationshipActions.addRelationship = origAdd;
        if (origRemove) RelationshipActions.removeRelationship = origRemove;
    } catch { }
    origAdd = origRemove = null;
}

export default definePlugin({
    name: "MenuCleanup",
    description: "Ordena y limpia algunos menús contextuales de Discord.",
    authors: [{ name: "Richardant", id: 0n }],

    patches: [
        {
            // Respaldo a nivel de código: no eliminar a alguien que es tu amigo
            find: "removeRelationship:(",
            replacement: {
                match: /removeRelationship:\((\i),\i,\i\)=>/,
                replace: "$&$self.blocked($1)?Promise.resolve():"
            }
        }
    ],

    blocked(userId: string) {
        return isFriend(userId);
    },

    start() {
        addGlobalContextMenuPatch(menuPatch);
        wrapActions();
    },

    stop() {
        removeGlobalContextMenuPatch(menuPatch);
        unwrapActions();
    }
});
