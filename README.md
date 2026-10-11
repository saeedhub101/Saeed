# Saeed (Avatar Agent)

Desktop 3D assistant and agent for Windows. Core app is small; abilities come from **add-ons** that start only when needed.

Desktop 3D avatar for Windows (Electron + three.js).

## Phase 1 — character and studio
Tray app, transparent draggable character window, mic button, independent motion engine (send an intent such as `happy`, the engine picks the movement), and the **Studio** (tray → Studio): Bones (remap, now with fingers, eyes, jaw), Pose (T-pose fix), Fix motions (axis swap / flip), Create motion (keyframes + generator), Face (shape keys, jaw test), Rig builder (skeleton for models without one, with fingers / eyes / jaw), Test.

## Phase 2 — voice, brain, chat, settings
- **Talk by microphone**: mic button → your speech is detected by an RMS gate → speech-to-text → brain → text-to-speech. Saeed stops talking when you speak above the *interrupt* level.
- **Chat window** (tray → Chat, or double-click the character): same conversation and same brain as the voice.
- **Settings window** (tray → Settings): separate provider for each service.
  - Speech to text: local Whisper (built in), OpenAI, ElevenLabs, or any OpenAI-compatible server (Groq...).
  - Brain: Claude (Anthropic), OpenAI, or any OpenAI-compatible server (Ollama, OpenRouter...).
  - Voice: Windows voices (offline), OpenAI, ElevenLabs, or OpenAI-compatible.
  - Sound levels: output volume, RMS to start listening (e.g. 0.09), RMS to interrupt Saeed, silence length, microphone gain, live meter with the two thresholds, mute (words appear in the bubble above the head).
  - Prayer times + adhan, Quick launch list.
- **Simple commands run on the PC without the brain** (instant, offline): time, "open Excel / Word / PowerPoint / Notepad / Calculator / My Computer / Downloads…", items from your Quick launch list, sit / lie down / sleep / stand up. Everything else goes to the brain. The brain can also open allowed items and show emotions through tools.
- **Hide me** (tray) hides the character and stops microphone, sound and the brain (the brain stays available only while the chat window is open).
- API keys are encrypted with Windows DPAPI and never leave the main process.

### New motions
`sit`, `lie`, `sleep` (postures; the engine blends into them and re-frames the camera), `adhan` (hands raised beside the face), `listen`. At prayer time Saeed plays the adhan audio file you choose, raises his hands, and opens the **jaw bone** from the sound level while the letter shape keys (A I U E O / aa ih ou ee oh) follow the voice. Without an audio file he announces the prayer by voice.

### Prayer times
One request per month to the Aladhan service, saved on the PC. Pick city, country and calculation method (Jordan: Ministry of Awqaf). Check the times against your local mosque.

## Phase 4 — streaming, screen control, charts, outfits, a living face
- **Streaming replies**: the brain's answer is spoken while it is still being written (sentence by sentence) and appears word by word in the chat. Works with Claude and OpenAI-compatible servers; tool use and images (screenshots) work inside the same loop. Raise "Steps allowed per request" (Settings → Agent) for long tasks.
- **Procedures** (Settings → Procedures): describe how to work in one of your company systems (program, screens, fields, order, what to check). When a request contains one of the keywords, Saeed follows that text.
- **Screen control** (add-on `desktop-control`, Windows): Saeed takes a screenshot, understands it, and uses mouse and keyboard in small checked steps. Safety: permission "See the screen and control mouse and keyboard" (Ask for this task / Always / Deny), a red **STOP bar** on top of the screen (hidden from screenshots), **Ctrl+Alt+X** stops everything at once, actions are refused while Task Manager, PowerShell, Registry Editor, Windows Security… is in front (editable list), every step is logged under Permissions → Activity, and Saeed uses `confirm_with_user` before irreversible steps (submit, issue, send, pay, delete). Works best with Claude (it reads screenshots well).
- **Charts and drawings** (add-on `charts`): `plot` (X-Y curves with duty point, second axis for efficiency, smooth curves), `system_curve`, `pump_select` (rank pumps by head at the duty flow, margin, efficiency, % of BEP), `well_section` (vertical section of a borehole installation with dimensions, English or Arabic). SVG, or PNG when the PNG engine is installed.
- **Outfits and accessories**: besides parts attached to one bone, **outfits** are skinned clothes made for the same skeleton: they bend with the body. One outfit per slot (top, bottom, shoes…). Body meshes can be hidden so they do not poke through (Studio → Accessories → Character meshes). Add-ons → **New accessory pack…** turns your own .glb into an add-on without writing JSON.
- **A living face** (Studio → Face):
  - Map the model's **shape keys** to **mouth shapes** (A E I O U M F TH S SH CH J R L N D T K G KH H Q AYN W Y), to expressions (smile, sad, angry, surprised, worried, laugh, kiss, tongue out, wink, brows, look left/right/up/down, jaw) and to your own named expressions. "Auto-detect by name" does the first pass; unmapped mouth shapes use the nearest mapped one.
  - **Lip-sync from the letters**: Arabic and English text is turned into mouth shapes, laid over the real length of the voice and shaped by its loudness (pauses close the mouth). The jaw bone follows. Questions and exclamations raise the brows.
  - Blinking (with occasional double blinks), wandering eyes (bones and/or shape keys), listening brows, small unplanned smiles and brow flashes keep the face alive.
  - **Animations inside the GLB** (face or body) are listed: play them, turn them on, play them together with or as variants of what Saeed expresses (happy, wink, laugh…), or **make a pose from a clip** (a letter animation becomes that mouth shape).
  - Mapping is saved per character; copy / paste it as text.

## Phase 3 — add-ons, live conversation, updates
### Add-ons (tray → Add-ons…)
An add-on is a folder (or a .zip) with `addon.json` + `index.js`. It can provide **tools** for the brain (read an Excel file, fill a form...), **providers** (speech recognition, voices) and **accessories** (hat, flag, flowers). Each add-on runs in **its own process**, started on the first call and **stopped when idle** (default 90 s) or when Saeed is hidden. Nothing runs in the background.
- **Installed** tab: turn on/off, add-on options, running status, stop, remove. **Store** tab: list from your GitHub repository, install with progress and checksum verification. **Install from file…** for a local .zip.
- Included (source in `addons/`): `files-basic`, `excel` (read, write cells and formulas, rows, new workbooks), `word` (read, create with headings and tables, RTL), `pdf` (read text), `ocr` (Arabic + English from images), `whisper-local` (offline speech recognition, replaces the old built-in Whisper so the installer stays small), `party-pack` (accessories, no code).
- **Safety**: every sensitive action goes through **Permissions** (below). Add-ons are programs: install only ones you trust. "Stop everything" in the tray stops the brain, the live session and every add-on.
- **Images**: attach or paste a picture in the chat (📎 / Ctrl+V). Claude and OpenAI models read it directly, for example a catalog page to rewrite as a table.

### Add-on format
```
my-addon/
  addon.json    { id, name, version, description, author, main, permissions, idleSeconds,
                  tools:[{name, description, risk:"read"|"write"|"system", schema}],
                  provides:{stt:{label}} | {tts:{label}},  settings:[{key,label,type,default,options}],
                  accessories:[{id,name,bone,offset,rotation,scale, parts|file}] }
  index.js      module.exports = { tools:{ name: async (args, ctx) => result }, stt:{transcribe}, tts:{synthesize},
                                   activate(ctx), deactivate() }
```
`ctx`: `await access(path, 'read'|'write'|'delete'|'delete-permanent')` (returns the real path or throws when refused; asks the user when needed), `await trash(path)` (Recycle Bin), `await permit(cap, detail)` (actions that are not about a file), `isBlocked(path)`, `settings`, `dataDir`, `addonDir`, `status(text)`, `log()`. Tools list the permissions they need in `perm`, for example `"perm": ["files.write"]`.
Accessory parts: `cone, cylinder, sphere, box, plane, torus`, sizes in metres on a 1.7 m character; they follow the bone and are adjusted in Studio → Accessories.

### Publishing add-ons
```
npm run build-addons      # run on Windows x64: installs dependencies, downloads OCR data, writes dist-addons/*.zip and addons/registry.json
```
Upload the zips to a GitHub release tagged `addons`, commit `addons/registry.json`, and set Settings → Updates → repository to `owner/repo`.

### Permissions (tray → Permissions…)
- **What Saeed may do**: for each kind of action choose **Ask / Allow / Deny**: read files, create and change files, delete (Recycle Bin), delete permanently, open apps, run commands, control the screen, use the internet from add-ons.
- **Where**: a list of folder rules (Ask / Allow / Deny). The most specific folder wins, and the action permission and the folder rule both count (Deny beats Ask beats Allow). Windows folders (`C:\Windows`, Program Files, ProgramData, AppData) start as **Deny**, but you can set them to Ask or Allow, or add any folder or whole drive. Places not in the list use their own default (Ask).
- **Ask** opens a window with *Allow once / Always allow / Deny*. "Always allow" is remembered per add-on and action (and per folder when the folder rule asked); revoke it under **Always allowed**.
- **Try a path** shows what would happen for a path without doing it. **Activity** lists every decision (who, what, where, allowed or denied).
- **Danger zone**: deleting a whole drive, the Windows folder or your user folder stays blocked until you switch it on.
- The decision is made in the main process, not in the add-on, and symbolic links are resolved first, so a link cannot lead outside a rule.

### Live conversation (Settings → Live conversation)
Provider **OpenAI Realtime** or **Custom** (address, model, voice, protocol, sample rate, key header, extra headers). When a provider is selected the mic button starts a live session: audio streams to the server, its voice plays back with lip-sync, tools and gestures work, and you can interrupt (your "stop talking" level). The connection is open only while the mic is on. Typed chat keeps using the Brain.

### Updates (tray → Check for updates…)
Uses GitHub Releases through electron-updater: a small window shows *up to date* or *version X available (Update now / Later)*, then download progress (MB, speed, time left), then restart-and-install. Optional automatic daily check.
1. In `package.json` → `build.publish` put your GitHub `owner` and `repo`.
2. Set `GH_TOKEN` (a token with repo access) and run `npm run release`; publish the draft release it creates.
3. Raise `version` in `package.json` for each release.

### Lifecycle and resources
| Part | Starts | Stops |
|---|---|---|
| Character drawing | when shown | paused when hidden; low frame rate while idle |
| Microphone / audio output | mic button / first sound | mic off; output device released after 30 s |
| Add-on process (Excel, Whisper...) | first use | idle timeout, hide, "Stop everything" |
| Live session (WebSocket) | mic on (live mode) | mic off, hide |
| Prayer timer | enabled in settings | disabled |
Settings → Performance shows live memory and CPU per process.

## Run
```
npm install
npm start
```
`npm install` copies three.js into `src/vendor/three` (electron-builder strips `node_modules/*/examples`).

## Build the installer
```
npm run dist
```
Output: `dist/Avatar Agent Setup 0.4.0.exe`. Speech recognition on this PC is now the **whisper-local** add-on, so the installer stays small.

## Conventions
Rotations are in model space (degrees), on top of the rest pose: facing +Z, +Y up, character's left = +X, rest pose = standing with arms down (Pose → Arms down). If a model faces away use "Model faces" in the Studio top bar.

## Entry points
Window: `window.avatar.command('happy')`, `.say(text)`, `.mic.start()/stop()`. Intents are in `src/shared/clips.js` (`INTENTS`); override in `config.json` → `intents`.

## Layout
```
src/main/      main.js, preload.js, brain.js, llm.js, providers.js, pipeline.js, actions.js, prayer.js, secrets.js, settings.js,
               addons.js, addon-host.js, permissions.js, realtime.js, updater.js
addons/        reference add-ons (source)  ·  scripts/ vendor.js, build-addons.js
src/renderer/  avatar.*, studio.*, settings.*, chat.*, addons.*, update.*, voice.js
src/shared/    character.js, clips.js, schema.js, rigbuilder.js, accessories.js
```

## Not done yet
- Outfit files must be skinned to the same skeleton (same bone names and rest pose).
- Screen control sees the main monitor only, and needs a vision-capable model.
- Not tested on a real machine. Errors appear in a red box in each window; tray → Developer tools opens the console.
