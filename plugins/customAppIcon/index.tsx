/*
 * CustomAppIcon — permite elegir la imagen que usa Vesktop como icono de ventana
 * (barra de tareas / alt+tab). La imagen la elige el usuario desde su PC.
 */

import { definePluginSettings } from "@api/Settings";
import { Button } from "@components/Button";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { showToast, Toasts, useEffect, useState } from "@webpack/common";

const Native = VencordNative.pluginHelpers.CustomAppIcon as PluginNative<typeof import("./native")>;

function IconPicker() {
    const [path, setPath] = useState<string | null>(null);
    useEffect(() => { void Native.getIconPath().then(setPath); }, []);

    const choose = async () => {
        try {
            const p = await Native.chooseIcon();
            if (p) { setPath(p); showToast("Icono aplicado", Toasts.Type.SUCCESS); }
        } catch (e) {
            showToast(String(e), Toasts.Type.FAILURE);
        }
    };
    const reset = async () => {
        await Native.resetIcon();
        setPath(null);
        showToast("Icono restablecido (puede requerir reiniciar Vesktop)", Toasts.Type.MESSAGE);
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ color: "var(--text-normal)" }}>
                {path ? `Icono actual: ${path.split(/[\\/]/).pop()}` : "Usando el icono de Vesktop"}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
                <Button onClick={choose}>Elegir imagen…</Button>
                {path && <Button variant="secondary" onClick={reset}>Restablecer</Button>}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                Recomendado: PNG cuadrado de 256×256 o un .ico. Los accesos directos anclados usan su propio icono
                (clic derecho → Propiedades → Cambiar icono).
            </div>
        </div>
    );
}

const settings = definePluginSettings({
    icon: {
        type: OptionType.COMPONENT,
        description: "Icono de la ventana",
        component: IconPicker
    },
    cleanTitle: {
        type: OptionType.BOOLEAN,
        description: "Quitar el contador de menciones \"(2)\" del título de la ventana (como la app oficial)",
        default: true,
        onChange: () => refreshTitle()
    }
});

// Discord web pone "(N) " o "• " delante del título; la app oficial no lo muestra.
const COUNT_PREFIX = /^(\(\d+\+?\)|•)\s*/;
const titleDesc = Object.getOwnPropertyDescriptor(Document.prototype, "title")!;
let rawTitle = "";
let titleObserver: MutationObserver | null = null;

function refreshTitle() {
    titleDesc.set!.call(document, settings.store.cleanTitle ? rawTitle.replace(COUNT_PREFIX, "") : rawTitle);
}

export default definePlugin({
    name: "CustomAppIcon",
    description: "Cambia el icono de Vesktop en la barra de tareas por una imagen que elijas.",
    authors: [{ name: "Richardant", id: 0n }],
    settings,

    start() {
        rawTitle = titleDesc.get!.call(document);
        Object.defineProperty(document, "title", {
            configurable: true,
            get: () => titleDesc.get!.call(document),
            set: (v: string) => { rawTitle = String(v); refreshTitle(); }
        });
        refreshTitle();

        // Discord a veces cambia el texto del <title> directamente (sin pasar por document.title)
        titleObserver = new MutationObserver(() => {
            const t = titleDesc.get!.call(document);
            if (settings.store.cleanTitle && COUNT_PREFIX.test(t)) {
                rawTitle = t;
                refreshTitle();
            }
        });
        titleObserver.observe(document.head, { subtree: true, childList: true, characterData: true });
    },

    stop() {
        titleObserver?.disconnect();
        titleObserver = null;
        delete (document as any).title;
        titleDesc.set!.call(document, rawTitle);
    }
});
