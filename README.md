# Audioet

Transcribe notas de voz largas (unas 2 o 3 horas) en el navegador. La interfaz está en español. No hay cuentas: quien abre la página puede usarla.

El audio **no se guarda**. No hay base de datos, ni Blob, ni disco. El archivo solo vive en la memoria de la pestaña y, fragmento a fragmento, en la memoria de la petición que lo está transcribiendo.

## Cómo funciona

1. Eliges o arrastras un audio (`m4a`/`aac` de iPhone o WhatsApp, `ogg`/`opus` de WhatsApp, `mp3`, `wav`, `webm`). Eso **no** empieza la transcripción.
2. Antes de pulsar **Transcribir** eliges el modelo y, si quieres, dos opciones (las dos empiezan desmarcadas): **Identificar quién habla** y **Incluir marcas de tiempo**. El modelo por defecto es **Grok (x-ai/grok-stt-2.0)**; también puedes elegir **Microsoft (microsoft/mai-transcribe-2)**. El navegador manda la clave (`grok` o `microsoft`), no el id del modelo. El servidor solo acepta esas dos.
3. El navegador carga **ffmpeg.wasm de un solo hilo** (no hace falta `SharedArrayBuffer` ni cabeceras COOP/COEP). El archivo se monta con **WORKERFS**, así que los ~300 MB no se copian al heap de wasm.
4. Cada fragmento se recodifica a **mono, 16 kHz, MP3 a 32 kbps** y se sube a `POST /api/transcribe`.
5. Esa ruta de Next.js (runtime Node, `maxDuration` 300) reenvía el audio a OpenRouter y devuelve `{ text, cost, seconds, costKnown, words, segments }`. Si `usage.cost` no viene, `cost` es 0 y `costKnown` es falso. El navegador no habla con OpenRouter.
6. Se transcriben **3 fragmentos a la vez** mientras se codifica el siguiente. Si uno responde 429, 5xx o se cae la red, se reintenta con espera exponencial (1 s, 2 s, 4 s, hasta 4 intentos). Si pesa demasiado (413) o el proveedor no responde a tiempo (408/504/524), el fragmento se parte por la mitad y se vuelve a intentar.
7. El texto se concatena **en orden de índice**. La caja grande se va llenando con el prefijo ya terminado. Puedes copiarlo, editarlo y recargar: el texto, el costo y las opciones quedan en `localStorage` hasta que pulses **Borrar** o elijas **otro** archivo. Si vuelves a elegir el mismo archivo, se retoman solo los fragmentos que faltan, con las mismas opciones.
8. El costo en USD se suma con cada llamada (también un reintento que luego funciona, y un fallo que igual trae `usage.cost`). El total y los minutos de audio facturados se guardan junto al texto y se ponen a cero al borrar o al elegir otro archivo. Junto a **Copiar** se lee, por ejemplo, `Costo de esta transcripción: US$0,0123 · 3,5 min de audio`.

El idioma no se fuerza: OpenRouter lo detecta. Los colores siguen el tema del sistema (`prefers-color-scheme`).

### Texto, voces y marcas de tiempo

Sin ninguna de las dos casillas, la respuesta es texto continuo. Las palabras con tiempo solo se usan por dentro para alinear; en pantalla no hay una línea por palabra.

- **Marcas de tiempo:** un `[hh:mm:ss]` al principio de cada frase (o de un bloque de unos 30 s si no hay punto). La hora es la del audio completo, no la del fragmento.
- **Quién habla:** las frases seguidas de la misma persona se juntan en un párrafo, `Speaker 1: …`, `Speaker 2: …`. Si también hay marcas, el párrafo lleva **una** sola, al principio.
- Con **Grok** y voces, la petición usa `response_format: verbose_json` y `provider.options.xai.diarize`. Grok rechaza `diarize` en la raíz. Esa separación es poco fiable (a veces marca a todo el mundo como la misma persona). La pantalla lo avisa y recomienda Microsoft.
- Con **Microsoft** y voces, la petición usa `verbose_json` y `diarize: true`. Microsoft sí separa las voces en la prueba que se hizo.
- El solape de 5 s se quita por tiempo: del segundo fragmento en adelante se descartan las palabras que empiezan antes del final del fragmento anterior. No se usa el recorte por palabras, porque se comería la etiqueta `Speaker N`.

Los ids de hablante empiezan de cero en cada fragmento de 10 minutos. Cuando termina el audio, si pediste voces, `POST /api/speakers` manda a OpenRouter un extracto corto (primera y última frase de cada persona, y las frases donde alguien dice su nombre) al modelo de chat `x-ai/grok-4.3` (el Grok general más barato que figuraba en el catálogo público; no hay un modelo “mini”). Pide un JSON que unifica a la misma persona entre fragmentos y cambia `Speaker N` por un nombre solo si la conversación lo dice claro (“soy Ana”). No reescribe lo dicho. Ese costo se suma al total; los segundos del chat no se suman a los minutos de audio. Si falla, se dejan las etiquetas de cada fragmento y se avisa en español.

## Tamaño de fragmento

| Parámetro | Valor | Por qué |
| --- | --- | --- |
| Duración | 10 min (600 s) | Cabe holgado en el límite de 4,5 MB del body de una función de Vercel y da pocos viajes para una nota de 3 horas (19 fragmentos). |
| Solape | 5 s | El seek rápido (`-ss` antes de `-i`) cae en un keyframe. Esos 5 s tapan el corte y dan palabras repetidas para deduplicar. |
| Dedup | 4 palabras o más | Si el final de un texto y el principio del siguiente coinciden, se quita la repetición. Coincidencias más cortas (“de la”, “en la casa”) se dejan, para no comerse texto de verdad. |
| Formato | MP3, mono, 16 kHz, 32 kbps | `32 kbps × 600 s / 8 = 2.400.000 bytes` (~2,3 MB). El POST al servidor es el binario (multipart), no base64, así que no se infla un 33 % en el tramo limitado a 4,5 MB. |
| Tope en el cliente | 3,5 MB | Si un fragmento sale más grande, se divide antes de subirlo. |
| Tope en la ruta | 4,2 MB | Por debajo del 413 de Vercel (`FUNCTION_PAYLOAD_TOO_LARGE`). |
| Concurrencia | 3 | Varias transcripciones en vuelo mientras ffmpeg codifica la siguiente. ffmpeg en sí va de uno en uno. |

La ruta, por defecto, llama a OpenRouter con el JSON documentado:

```json
{
  "model": "x-ai/grok-stt-2.0",
  "input_audio": { "data": "<base64, sin prefijo data:>", "format": "mp3" }
}
```

No se envía `language`. Con voces o marcas se añade `response_format: verbose_json`. Microsoft con voces añade `diarize: true`. Grok con voces añade `provider.options.xai.diarize` y no manda `diarize` en la raíz. La constante `UPSTREAM_MODE` en `lib/config.ts` puede pasar a `"multipart"` (campo `file` + `model`) si el JSON da problemas; en multipart no viaja la opción de proveedor de Grok, así que la diarización de Grok se queda en JSON. El mensaje de error de OpenRouter se muestra en la pantalla, sin la clave.

OpenRouter corta la transcripción aguas arriba alrededor de los 60 s. Por eso la ruta aborta a los 70 s y el cliente parte ese fragmento. El `maxDuration` de 300 s es el máximo del plan Hobby y solo evita que Vercel mate la función antes.

Si el core de wasm no trae `libmp3lame`, se usa AAC (`.m4a`, 32 kbps) y luego Opus (`.ogg`, 24 kbps). El build actual sí trae `libmp3lame`.

## Variables de entorno

Copia `.env.example`. En local puedes crear `.env.local` (no se commitea). En Vercel: Project → Settings → Environment Variables.

| Variable | Obligatoria | Uso |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Sí, para transcribir | Solo en el servidor. Nunca se manda al navegador ni se escribe en logs. |
| `OPENROUTER_SITE_URL` | No | Se manda como `HTTP-Referer`. Si falta, se usa el `Origin` de la petición. |

Sin la clave, `/api/transcribe` y `/api/speakers` responden 422 con `Falta OPENROUTER_API_KEY en el servidor.` `/api/speakers` (`maxDuration` 60) solo recibe extractos de texto, nunca audio.

## Proyectos en Vercel (Hobby)

Dos proyectos, el mismo repositorio:

| Proyecto | Rama de producción |
| --- | --- |
| `audioet` | `main` |
| `audioetdev` | `dev` |

En los dos hay que poner `OPENROUTER_API_KEY`. Hobby permite funciones de hasta 300 s y un body de 4,5 MB; la app está calibrada para eso. El audio no usa Vercel Blob ni ningún otro almacenamiento.

La ruta rechaza `POST` cuyo `Origin` no coincida con el host (un sitio ajeno no puede gastar la clave). Quien abre Audioet sí puede, porque la app es pública y no tiene login.

## Desarrollo

```bash
npm install
npm run dev
```

`npm install` copia el core de ffmpeg (~31 MB de wasm y el JS) a `public/ffmpeg/`. Esa carpeta no va a git: se genera en el install y otra vez en `next build`, que es lo que ejecuta Vercel.

```bash
npm test                 # plan de cortes, dedup, reintentos, forma del request, la ruta
npm run test:chunks      # ffmpeg del sistema: nota sintética larga, tamaños y duración
npm run test:wasm        # Chrome headless: WORKERFS + el mismo comando de corte
npm run build
```

## Pruebas locales del corte

Con ffmpeg del sistema, los mismos argumentos que usa el navegador (`lib/ffmpeg-args.ts`):

- Entrada tipo iPhone: 20 min, estéreo, AAC 128 kbps, 19.407.266 bytes. Un trozo de 10 min de ese archivo, sin recodificar, pesaría 9,6 MB y no pasaría por Vercel.
- Salida: 3 fragmentos MP3, mono, 16 kHz, 32 kbps.
  - 600 s → 2.400.660 bytes (600,08 s)
  - el resto, 10 s → 40.644 bytes
- Entrada tipo WhatsApp: 25 s Opus/Ogg → un MP3 de 100.593 bytes, 16 kHz, mono.
- En Chrome, ffmpeg.wasm con WORKERFS recodificó 20 s de AAC estéreo a un MP3 de 80.676 bytes, 16 kHz, mono, 20,09 s. El wasm eligió `libmp3lame`.

No hay llamadas reales a OpenRouter en los tests: no tenemos la clave. El upstream se simula. La prueba en vivo es después del deploy.

## Limitaciones

- La primera visita descarga unos **31 MB** de `ffmpeg-core.wasm`. El navegador los cachea. En un móvil, con datos justos, esa descarga ya se nota.
- El core es de **un solo hilo**. Codificar 3 horas puede tardar tanto como el audio, o más, sobre todo en un teléfono. Hay que dejar la pantalla encendida y la pestaña abierta. En el móvil se pide Screen Wake Lock y se avisa; en modo de bajo consumo iOS puede denegarlo.
- Si cierras la pestaña a medias, el texto ya hecho sigue en `localStorage`. El audio no. Para seguir, vuelve a elegir **el mismo** archivo (mismo nombre, tamaño y fecha). **Borrar** tira el texto.
- El solape y el dedup no son perfectos. El seek cae en un keyframe, así que en el corte pueden sobrar o faltar un par de palabras. Si el modo con voces no trae palabras ni segmentos, se deja el texto plano y el solape puede repetirse.
- Grok, con la opción de voces, a menudo etiqueta a todo el mundo como la misma persona. Microsoft lo hace mejor. La unificación de nombres entre fragmentos depende del modelo de chat y puede equivocarse; un nombre solo sustituye a `Speaker N` cuando el extracto lo deja claro y la respuesta es una etiqueta corta.
- No hay un Grok “mini” en el catálogo público. Unificar hablantes usa `x-ai/grok-4.3` y suma un costo pequeño aparte de los minutos de audio.
- `decodeAudioData` no se usa: el PCM de varias horas no cabe en un móvil.
- La página es pública. Quien la abre gasta crédito de OpenRouter. No hay auth a propósito.
- El core `@ffmpeg/core@0.12.10` es **GPL-2.0-or-later** (el build incluye libmp3lame). El código está en [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm). No lo modificamos; se sirve tal cual al navegador.
