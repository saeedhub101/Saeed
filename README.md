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

## Phase 7 — a new icon, and a soul
**App icon**: replaced with the circular portrait/AI badge image given for this, keyed to a transparent background (1024×1024 PNG) so it renders cleanly in the taskbar, the tray, and the Windows installer - no other change needed, `npm run dist` builds the installer icon from it automatically.

**Liveliness** (`src/renderer/behavior.js`, used by the avatar window only): inspired by how the Merlin-the-Wizard desktop-pet project keeps a character feeling present without being annoying - energy that quietly drains while idle and recovers on interaction, picks biased away from whatever was just played so nothing repeats back-to-back, and everything gated so it never fires while Saeed is speaking, listening, thinking, or mid-gesture:
- **A one-time greeting** - a small wave, once, shortly after Saeed appears - not repeated.
- **Eyes that glance toward the real mouse cursor** when it is near the window (not just the existing random idle wander), using the actual OS cursor position, checked every 10-18 s.
- **Occasional spontaneous fidgets** (an idle look-around, a small smile, a wink, a brow raise) every 14-24 s, more often when "energy" is high, sparser late at night, never while busy.
- **Sleeps after about 15 minutes with no real engagement** (chat, voice, dragging...) and **wakes with a glad-to-see-you gesture** (greet/wave/happy) the moment you come back - reusing the same "last engaged" clock the app already keeps for its frame-rate throttling, so this costs nothing extra to track.
This is a first pass, not a port of Merlin's full engine (which also has mood palettes and a time-of-day system) - tell me if you'd like those too, or if the timings feel off once you've seen it running.

## Phase 6.2 — ships wide open by default, at the user's explicit request
Every permission now ships as **Allow**, including Windows system folders, deleting permanently, running commands, and controlling the screen - Saeed no longer asks before acting, on a fresh install or after using the new button below. The one thing that stays behind its own separate switch, unaffected by any of this, is wiping a whole drive, the Windows folder or the user's profile folder outright (the **Danger zone** toggle in Permissions, off by default) - that is a last-resort guard against a single bad command erasing the system, not a nag, and the user can turn it off too.
Permissions now opens with a one-line status ("Full access - nothing asks or is blocked", or a count of what still does) and two buttons at the top: **Grant full access** (adopts the open defaults on an existing install) and **Restore safe restrictions** (goes back to asking before file changes, deleting, running commands, and screen/browser control, and denies Windows system folders again). Anyone distributing this app to other people should decide for themselves which of the two they want users to start with.

## Phase 6.1 — fixed: false "I can't access that" refusals, and the adhan pose
- **Root cause found and fixed:** a relative path ("Desktop/notes.txt", or just "notes.txt") was being resolved against the app's own working directory instead of the user's folders. That directory is denied by default (it sits under Program Files / AppData), so the very first file tool call silently failed, and the model then over-generalized that one denial into "I can't access your files" instead of noticing the real, fixable reason. Relative paths with no drive letter now resolve under the user's own home folder (Desktop, Documents, Downloads…) automatically, for every file tool and every add-on.
- The brain is now explicitly told never to claim a general inability to access files, the internet, the screen or a program — to always try the matching tool first, and when a tool call is refused, to act on the actual reason it gives instead of giving up. This is instruction, not a hard guarantee: a capable model (Claude, GPT-4 class) follows it reliably; a small/local model may still occasionally refuse out of over-caution.
- **Browser logins (Facebook and similar):** the brain now knows to open the browser with `visible:true` for anything that needs the user's own account (so the user can see it and handle a CAPTCHA or code), and to click what opens the login form and take a fresh snapshot before concluding a field like the username box does not exist — large sites often load or reveal that form a moment after the page itself. This does not remove the sites' own defenses (CAPTCHAs, bot detection, 2FA) — those still need the user's help in the visible window.
- **The adhan pose**: the jaw no longer opens from the recording's loudness during adhan (it only did that because *any* playing audio drove the jaw automatically — nothing in the pose itself ever moved the jaw). The forearms are rotated 180° along their own length so the palms face the right way; this was done from the written description, without being able to preview the 3D result, so check it and say if the direction needs reversing (−180) or a different angle.

## Phase 6 — a general task engine (plan, explore, do, verify, learn) and a build check
**Fixed:** a crash ("installUrl is not defined") when opening the Add-ons Store. The project now runs `npm run check` before every build, which would have caught it: syntax, undefined names, every module and add-on manifest, and the preload/main/window wiring.

**Skill memory** (Settings → Skills Saeed learned), separate from what he remembers about you (`remember`) and from the Procedures you write by hand. Nothing needs to be said to make him learn — he is never asked "did this work, should I remember it?" and no extra step or confirmation is needed from you:
- **Captured automatically, in code, not by asking the model to remember.** Whenever a reply involved at least one real action (clicking or filling a field, running a database change, a command) in a program, a website or a database, the exact sequence is saved as a skill as soon as the reply finishes — with no extra round trip, so it costs no time and never depends on the model remembering to do it. Looking something up or exploring on its own is not saved (nothing to repeat); the model saving one itself (`learn_skill`) takes priority and skips the automatic one for that turn.
- **General by design, not "button position":** a step is recorded as *Fill in "ID number" in "InsureSys"*, never pixel coordinates or the value you typed — so the same skill still works with a different person's data, and survives small window moves (UI Automation tools are matched by name).
- **Found by itself:** before doing any work in a program, website or database, Saeed is instructed to always check for a matching skill first — this is a normal step for every such task, not something you ask for — and when one matches, he follows its steps directly instead of exploring from scratch, which is both faster and more reliable; he still checks the result rather than trusting it blindly.
- `update_skill(id, …)` with `outcome: 'failure'` demotes a skill that stopped working so it is not suggested again; `forget_skill(id)` deletes one. You can also just delete it in Settings.

**Flexible understanding of programs** (`desktop-control` v1.2): `explore_window` reads a window with UI Automation and only falls back to a screenshot when that finds almost nothing (unnamed-control programs); `list_windows` for tasks with several windows/dialogs; `ui_table` reads a grid/list-view control (rows and columns) instead of cell by cell.

**The planning loop** is written into the brain's instructions rather than hard-coded, so it applies to every tool (desktop, browser, database, files): explore before acting, work in small steps and re-explore after each one, re-plan instead of repeating clicks when the screen does not match what was expected, ask for missing required fields instead of guessing, verify the actual result before reporting success, and confirm before anything irreversible.

**Interface language as an add-on**: `lang-ar` (Arabic, right-to-left, included) translates known interface texts live, in every window, without changing the code — Settings → Language lists whatever language add-ons are installed. A language add-on is just `addon.json` with `provides.language: { code, name, rtl, file }` plus a `strings.json` of `"English text": "translation"`; `node scripts/extract-strings.js` lists the interface's current English texts as a starting point for a new one.

**Still not automatic:** a database connection is never discovered or opened on its own — you set up each one (Settings for the `database` add-on) with its connection details and your own credentials; Saeed only ever uses a connection you configured. Outfits/accessories from ready clothing sites are not fetched automatically; a direct link (Add-ons → Install from link…) or **New accessory pack…** from your own .glb covers this for now.

## Phase 5 — Saeed works like a person at the computer
**Built in (no add-on needed, controlled only by Permissions):**
- **Files anywhere**: `find_files` (Windows Search index first, then a fast folder walk; Desktop, Documents and Downloads by default, any folder or every drive on request), list, read, write, copy, move, delete (Recycle Bin or permanent), file info, **`open_path`** (opens any file or folder with its default program) and `view_image`. "Open test.xlsx" now finds the file by name and opens it; he no longer asks you for a path he can find himself.
- **Commands and system**: `run_command` (PowerShell or cmd, asks unless you allow it), `system_info`.
- **The internet in the background (no browser window)**: `web_search` (DuckDuckGo with no key, or Brave / Tavily), `web_fetch` (readable text of any page or API), `http_request` (call any web API; put passwords and tokens as `{{secret:NAME}}` and the value is filled in privately), `download_file`. Saved secrets are in Settings → Web.
- **Memory and reminders**: Saeed remembers lasting facts (and you can edit them in Settings), and sets spoken reminders with a notification.

**Add-on library (never empty any more):** the installer carries the library. On first run it installs `excel`, `word`, `pdf`, `charts`, `browser`, `database`, `desktop-control` and `party-pack`; `ocr` is offered in the Store; big or optional ones (`whisper-local`, `llm-llamacpp`, `tts-piper`) are listed with their download link. Store tabs: categories (Files and Office, Web, Data, Voice, Brains, Look), **Sources…** (add any registry.json link), **Install from link…** (a direct .zip add-on or a .glb outfit from any site), included / online badges.
- `browser`: a real browser through your own Edge or Chrome (hidden or visible), numbered page elements instead of screenshots, a persistent profile for logins, `{{secret:…}}` for passwords. Honest limits: big sites (Facebook, Google…) may block automation or ask for a CAPTCHA / SMS code; visible mode lets you do that step while Saeed continues. Use it for your own accounts and tasks.
- `database`: query company systems directly from their database (SQL Server, ODBC, OLE DB) with read-only `query` and guarded `execute` (one statement, WHERE required). Own permissions: *Read company databases* / *Change company databases*.
- `pdf` (v1.2): read, search, and **render a page as an image** so catalog tables, curves and drawings can be read visually.
- `desktop-control` (v1.1): besides screenshots, **UI Automation** tools (`ui_tree`, `ui_read`, `ui_set_text`, `ui_click`) read and fill the controls of Windows programs directly, without looking at the screen.
- Brains and voices as add-ons: `llm-llamacpp` (Qwen / Llama / any GGUF on this PC; it appears in Settings → Brain), `tts-piper` (offline voice; Settings → Voice), `whisper-local` (Settings → Speech to text). An add-on can provide `stt`, `tts` or `llm`; the contract is in the add-on format section.

**Lifecycle:** every window is destroyed when closed (its memory, timers and microphone go with it) and rebuilt when opened; add-ons start on first use and stop when idle; the browser closes with its add-on; the character draws at 12 fps when idle and about 6 fps after a minute of rest, with the pixel ratio capped at 1.5; the studio draws nothing when minimised. Settings → Performance lists the processes, windows and add-ons that are running.

**Publishing:** `npm run build-addons` builds every add-on on Windows x64 (installs dependencies, downloads OCR data) into `dist-addons/` and writes `build/addons-lib` (what the installer carries) and `addons/registry.json`. Upload the zips of the optional add-ons to a GitHub release tagged `addons` and set Settings → Updates → repository. `npm run dist` runs the build automatically (set `SKIP_ADDONS=1` to reuse the last one).

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
- Included (source in `addons/`): `excel` (read, write cells and formulas, rows, new workbooks), `word` (read, create with headings and tables, RTL), `pdf` (read text), `ocr` (Arabic + English from images), `whisper-local` (offline speech recognition, replaces the old built-in Whisper so the installer stays small), `party-pack` (accessories, no code).
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
Output: `dist/Avatar Agent Setup 0.6.0.exe`. `npm run dist` / `npm run release` now run `node scripts/check.js` first and stop if it fails.. Speech recognition on this PC is now the **whisper-local** add-on, so the installer stays small.

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
- Not tested on a real machine (most parts were tested without a screen or Windows: parsers, permissions, SQL guards, streaming, search, add-on manifests). Errors appear in a red box in each window; tray → Developer tools opens the console.
