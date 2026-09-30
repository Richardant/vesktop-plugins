/*
 * PopoutAlwaysOnTop — añade un botón de chincheta a las ventanas emergentes (popouts),
 * p. ej. al darle "Pop Out" a una transmisión, para dejarlas siempre encima,
 * como en la app oficial de Discord.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType, PluginNative } from "@utils/types";

const Native = VencordNative.pluginHelpers.PopoutAlwaysOnTop as PluginNative<typeof import("./native")>;

const settings = definePluginSettings({
    hideTitleBar: {
        type: OptionType.BOOLEAN,
        description: "Abrir los popouts sin barra de título (aparece una barra al pasar el mouse por arriba)",
        default: true
    },
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

const MIN_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><rect x="3" y="7.4" width="10" height="1.4" rx=".7"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>`;
const BAR_CLASS = "vc-paot-bar";
const BAR_CSS = `
.${BAR_CLASS} {
    position: fixed; top: 0; left: 0; right: 0; height: 30px; z-index: 100001;
    display: flex; align-items: center; gap: 2px; padding: 0 4px;
    background: linear-gradient(rgba(0,0,0,.8), rgba(0,0,0,.45));
    color: #fff; font: 600 12px/1 sans-serif;
    opacity: 0; pointer-events: none; transition: opacity .15s;
}
.${BAR_CLASS}.vc-paot-show { opacity: 1; pointer-events: auto; }
.${BAR_CLASS} .vc-paot-drag {
    flex: 1; height: 100%; display: flex; align-items: center; padding-left: 6px;
    overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    -webkit-app-region: drag; app-region: drag;
}
.${BAR_CLASS} .${BTN_CLASS} { color: #ddd; margin: 0; }
.${BAR_CLASS} .vc-paot-close:hover { background: #e81123; color: #fff; }
`;

let originalOpen: typeof window.open | null = null;
const tracked = new Set<Window>();

function updateButton(btn: HTMLButtonElement, pinned: boolean) {
    btn.setAttribute("aria-pressed", String(pinned));
    btn.title = pinned ? "Quitar siempre encima" : "Siempre encima";
}

function makePinButton(win: Window) {
    const doc = win.document;
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
    return btn;
}

function ensureBar(win: Window, pin: HTMLButtonElement) {
    const doc = win.document;
    const bar = doc.createElement("div");
    bar.className = BAR_CLASS;

    const drag = doc.createElement("div");
    drag.className = "vc-paot-drag";
    drag.textContent = doc.title || "Discord";

    const min = doc.createElement("button");
    min.className = BTN_CLASS;
    min.title = "Minimizar";
    min.innerHTML = MIN_ICON;
    min.addEventListener("click", () => { win.focus(); void Native.minimize(); });

    const close = doc.createElement("button");
    close.className = `${BTN_CLASS} vc-paot-close`;
    close.title = "Cerrar";
    close.innerHTML = CLOSE_ICON;
    close.addEventListener("click", () => win.close());

    bar.append(drag, pin, min, close);
    doc.body.appendChild(bar);

    // Las zonas de arrastre no reciben eventos del mouse en Windows, así que mostramos la barra
    // cuando el mouse se acerca al borde superior y la ocultamos al bajar o salir de la ventana.
    if (!(win as any).__vcPaotBarListeners) {
        (win as any).__vcPaotBarListeners = true;
        let hideTimer = 0;
        const show = () => {
            win.clearTimeout(hideTimer);
            doc.querySelector(`.${BAR_CLASS}`)?.classList.add("vc-paot-show");
            const d = doc.querySelector(`.${BAR_CLASS} .vc-paot-drag`);
            if (d) d.textContent = doc.title || "Discord";
        };
        const hide = (delay = 600) => {
            win.clearTimeout(hideTimer);
            hideTimer = win.setTimeout(() => doc.querySelector(`.${BAR_CLASS}`)?.classList.remove("vc-paot-show"), delay);
        };
        doc.addEventListener("mousemove", e => (e.clientY <= 40 ? show() : hide()));
        doc.documentElement.addEventListener("mouseleave", () => hide(1500));
        // Mostrarla un momento al abrir, para que se note que existe
        show();
        hide(2500);
    }
}

function ensureButton(win: Window) {
    const doc = win.document;
    if (!doc?.body) return;

    if (!doc.getElementById(STYLE_ID)) {
        const style = doc.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS + BAR_CSS;
        doc.head.appendChild(style);
    }

    if (doc.querySelector(`.${BTN_CLASS}`)) return;

    const btn = makePinButton(win);

    // Sin barra de título: barra flotante propia (mover, fijar, minimizar, cerrar)
    if ((win as any).__vcPaotFrameless) {
        ensureBar(win, btn);
        return;
    }

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
    description: "Popouts (p. ej. una transmisión en Pop Out): botón para dejarlos siempre encima y opción de abrirlos sin barra de título.",
    authors: [{ name: "Richardant", id: 0n }],
    settings,

    start() {
        originalOpen = window.open;
        window.open = function (this: Window, ...args: Parameters<typeof window.open>) {
            const name = args[1];
            const isPopout = typeof name === "string" && name.startsWith("DISCORD_");
            const frameless = isPopout && settings.store.hideTitleBar;
            // Vesktop acepta "frame" en las features de window.open para sus popouts
            if (frameless) args[2] = args[2] ? `${args[2]},frame=no` : "frame=no";
            const w = originalOpen!.apply(this, args);
            if (w && isPopout) {
                (w as any).__vcPaotFrameless = frameless;
                trackPopout(w);
            }
            return w;
        } as typeof window.open;
    },

    stop() {
        if (originalOpen) window.open = originalOpen;
        originalOpen = null;
        for (const w of tracked) {
            try { w.document.querySelectorAll(`.${BTN_CLASS}, .${BAR_CLASS}, #${STYLE_ID}`).forEach(e => e.remove()); } catch { }
        }
        tracked.clear();
    }
});
