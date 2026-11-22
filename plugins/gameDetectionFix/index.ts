/*
 * GameDetectionFix — arregla la detección de juegos de Vesktop 1.6.9 / 1.7.0.
 *
 * Vesktop le pasa los juegos detectados a Discord parcheando su función
 * setObservedGamesCallback, pero su parche espera 4 argumentos y Discord ahora usa 3,
 * así que no se aplica: "No game detected" y no sale la actividad "Jugando a ...".
 * (Reportado en Vencord/Vesktop#1413.) Este plugin aplica el mismo parche con la forma nueva.
 * Cuando Vesktop lo corrija en una versión oficial, este plugin ya no hará falta.
 */

import definePlugin from "@utils/types";

export default definePlugin({
    name: "GameDetectionFix",
    description: "Arregla la detección de juegos de Vesktop (\"No game detected\" / no sale \"Jugando a ...\").",
    authors: [{ name: "Richardant", id: 0n }],

    patches: [
        {
            find: ",setSystemTrayApplications",
            replacement: {
                // Firma nueva de Discord: setObservedGamesCallback(a, callback, c)
                match: /setObservedGamesCallback\(\i,(\i),\i\)\{/,
                replace: "$&return window.VesktopPatchGlobals?.setObservedGamesCallback?.($1);"
            }
        }
    ]
});
