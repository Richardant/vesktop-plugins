# vesktop-plugins

Plugins propios para **Vencord en Vesktop (Windows)**, compilados automáticamente por GitHub Actions.

| Plugin | Qué hace |
|---|---|
| **AppAudioShare** | Al transmitir una **ventana**, envía solo el audio de esa app (como el Discord oficial). Al transmitir la **pantalla completa**, envía todo el audio menos Vesktop. Funciona aunque los audífonos tengan mejoras/surround activas (p. ej. Logitech G HUB HX2E). |
| **VoiceServerIndicators** | Muestra en la lista de servidores el icono de altavoz (gente en voice) o de pantalla (alguien transmitiendo), como la app oficial. |

## Cómo funciona

- `plugins/` — código de los plugins.
- `.github/workflows/build.yml` — cada día (y en cada cambio de `plugins/`) descarga la última versión de Vencord, le mete los plugins, compila y publica una **Release**.
- La compilación apunta el actualizador de Vencord a este repo, así que **Vesktop se actualiza solo** desde estas Releases (Ajustes → Vencord → Updater). El repo tiene que ser **público** para que el actualizador pueda leer las Releases.

## Instalación (una sola vez)

1. Descarga `vendroid.zip` de la última Release y descomprímelo en una carpeta, p. ej. `Vesktop\Data\vencordCustom`.
2. En Vesktop: **Ajustes → Vesktop Settings → Open Developer Settings → Vencord Location → Change** y elige esa carpeta.
3. Cierra Vesktop por completo (bandeja → Quit) y ábrelo. Activa los plugins en **Ajustes → Vencord → Plugins**.
4. Opcional: **Ajustes → Vencord → Updater → Automatically update**.

## Actualizar Vesktop (el programa)

Descomprime la nueva versión portable **encima de la misma carpeta** (sin borrar `Data`). Así se conservan la sesión, los ajustes y la ruta a `vencordCustom`.

## Créditos

- [Vencord](https://github.com/Vendicated/Vencord) (GPL-3.0)
- [loopback-capture](https://github.com/WerdoxDev/loopback-capture) (MIT) — captura de audio por proceso (WASAPI)
