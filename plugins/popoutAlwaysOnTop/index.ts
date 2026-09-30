/*
 * PopoutAlwaysOnTop — añade un botón de chincheta a las ventanas emergentes (popouts),
 * p. ej. al darle "Pop Out" a una transmisión, para dejarlas siempre encima,
 * como en la app oficial de Discord.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";

const Native = VencordNative.pluginHelpers.PopoutAlwaysOnTop as PluginNative<typeof import("./native")>;

const settings = definePluginSettings({
    autoPin: {
        type: OptionType.BOOLEAN,
        description: "Poner automáticamente siempre encima cada popout nuevo",
        default: false
    }
});

const BTN_CLASS = "vc-paot-btn";
const STYLE_ID = "vc-paot-style";

const PIN_ICON = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M5 1.5h6v1.2l-1 .8v3.3l2.3 2.2v1.2H8.6V15l-.6.9-.6-.9v-4.8H3.7V9l2.3-2.2V3.5l-1-.8z"/></svg>`;

const CSS = `
.${BTN_CLASS} {
    display: flex; align-items: center; justify-content: center;
    width: 28px; height: 22px; margin: 0 2px;
    border: 0; border-radius: 4px; background: transparent;
    color: var(--interactive-normal, #b5bac1); cursor: pointer;
    -webkit-app-region: no-drag; app-region: no-drag;
}
.${BTN_CLASS}:hover { background: var(--background-modifier-hover, rgba(255,255,255,.08)); color: var(--interactive-hover, #fff); }
.${BTN_CLASS}[aria-pressed="true"] { color: var(--brand-500, #5865f2); }
.${BTN_CLASS}[aria-pressed="true"] svg { transform: rotate(-45deg); }
.${BTN_CLASS}.vc-paot-floating {
    position: fixed; top: 6px; right: 120px; z-index: 100000;
    background: rgba(0,0,0,.55); opacity: .75;
}
.${BTN_CLASS}.vc-paot-floating:hover { opacity: 1; background: rgba(0,0,0,.75); }
`;

let originalOpen: typeof window.open | null = null;
const tracked = new Set<Window>();

function updateButton(btn: HTMLButtonElement, pinned: boolean) {
    btn.setAttribute("aria-pressed", String(pinned));
    btn.title = pinned ? "Quitar siempre encima" : "Siempre encima";
}

function ensureButton(win: Window) {
    const doc = win.document;
    if (!doc?.body) return;

    if (!doc.getElementById(STYLE_ID)) {
        const style = doc.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        doc.head.appendChild(style);
    }

    if (doc.querySelector(`.${BTN_CLASS}`)) return;

    const btn = doc.createElement("button");
    btn.className = BTN_CLASS;
    btn.innerHTML = PIN_ICON;
    updateButton(btn, (win as any).__vcPaotPinned === true);
    btn.addEventListener("click", async e => {
        e.stopPropagation();
        win.focus();
        const state = await Native.toggle();
        if (state === null) return;
        (win as any).__vcPaotPinned = state;
        updateButton(btn, state);
    });

    // Junto a los botones de ventana (minimizar/maximizar/cerrar) si existen; si no, flotante.
    const winButton = doc.querySelector<HTMLElement>('[class*="winButton"]');
    if (winButton?.parentElement) {
        winButton.parentElement.insertBefore(btn, winButton);
    } else {
        btn.classList.add("vc-paot-floating");
        doc.body.appendChild(btn);
    }
}

function trackPopout(win: Window) {
    if (tracked.has(win)) return;
    tracked.add(win);

    let observer: MutationObserver | null = null;
    let tries = 0;
    const attach = () => {
        if (win.closed) { tracked.delete(win); return; }
        if (!win.document?.body) {
            if (tries++ < 100) setTimeout(attach, 100);
            return;
        }
        ensureButton(win);
        // Discord vuelve a renderizar el popout; mantener el botón presente
        const obs = new win.MutationObserver(() => ensureButton(win));
        obs.observe(win.document.body, { childList: true, subtree: true });
        observer = obs;

        if (settings.store.autoPin) {
            setTimeout(async () => {
                win.focus();
                const state = await Native.set(true);
                if (state !== null) {
                    (win as any).__vcPaotPinned = state;
                    const btn = win.document.querySelector<HTMLButtonElement>(`.${BTN_CLASS}`);
                    if (btn) updateButton(btn, state);
                }
            }, 400);
        }
    };
    attach();

    win.addEventListener("beforeunload", () => {
        observer?.disconnect();
        tracked.delete(win);
    });
}

export default definePlugin({
    name: "PopoutAlwaysOnTop",
    description: "Añade un botón para dejar los popouts (p. ej. una transmisión en Pop Out) siempre encima, como en Discord oficial.",
    authors: [{ name: "Richardant", id: 0n }],
    settings,

    start() {
        originalOpen = window.open;
        window.open = function (this: Window, ...args: Parameters<typeof window.open>) {
            const w = originalOpen!.apply(this, args);
            const name = args[1];
            if (w && typeof name === "string" && name.startsWith("DISCORD_")) trackPopout(w);
            return w;
        } as typeof window.open;
    },

    stop() {
        if (originalOpen) window.open = originalOpen;
        originalOpen = null;
        for (const w of tracked) {
            try { w.document.querySelectorAll(`.${BTN_CLASS}, #${STYLE_ID}`).forEach(e => e.remove()); } catch { }
        }
        tracked.clear();
    }
});
