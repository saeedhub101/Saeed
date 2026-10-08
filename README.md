# Avatar Agent

Desktop 3D avatar for Windows (Electron + three.js). Phase 1:

- **Tray icon** is the core of the app: Hide me / Show me, Change character, Studio, Test, Start with Windows, Quit.
- **Transparent character window**: draggable, always on top, only the character is drawn, clicks pass through empty pixels. Mic button in the middle (on/off with a level ring). Mouse wheel zooms, double-click greets.
- **Independent motion engine**: you send an *intent* (`happy`), the engine picks the movement (cheer, wave...). Idle breathing and random looking-around run by themselves.
- **Studio** (tray → Studio):
  - **Bones**: map the bones of any GLB to the program's bones (auto-detect for Mixamo, VRM, Rigify, Unreal). Partial rigs are fine.
  - **Pose**: set the neutral pose; one click fixes T-pose rigs (arms down).
  - **Fix motions**: per bone, swap axes (use Z instead of X), flip signs, scale, extra rotation. Live preview.
  - **Create motion**: keyframe editor, a swing generator, new / duplicate / restore.
  - **Rig builder**: for models with no skeleton: template (full / upper body / arms only / head), move joints, auto-skin, export a rigged GLB.
  - **Test**: fire intents and speech-bubble text.
- Replace the character any time: tray → Change character.

## Run

`npm install` also copies the three.js files into `src/vendor/three` (script `scripts/vendor.js`). This is required: electron-builder removes `node_modules/*/examples` when packing, so the app must not load them from there.

```
npm install
npm start
```

## Build the installer (setup .exe)

```
npm run dist
```
Output: `dist/Avatar Agent Setup 0.1.0.exe` (NSIS, choose install folder, desktop + start menu shortcuts).

## Conventions (important)

All rotations are in **model space**, degrees, on top of the rest pose. The character faces +Z, +Y is up, the character's **left is +X**. The rest pose is *standing, arms down*, so use Pose → "Arms down" for T-pose models. If a model faces away, use "Model faces" in the Studio top bar.

## For the future brain (voice / LLM)

In the avatar window: `window.avatar.command('happy')`, `window.avatar.say('text')`, `window.avatar.mic.start()/stop()`.
From the main process or Studio: IPC `command` → `avatar.command(name, args)`. Custom motions you create can be triggered by their name.
Intents live in `src/shared/clips.js` (`INTENTS`); override per user in `config.json` under `intents`.

## Layout

```
src/main/      main.js (tray, windows, config, IPC), preload.js
src/renderer/  avatar.* (character window), studio.* (editor)
src/shared/    character.js (loader, pose math, engine), clips.js (motions), schema.js (bone names), rigbuilder.js
```
Settings are stored in `%APPDATA%/Avatar Agent/config.json`.

## Known limits

- Not yet tested on a real machine; expect small bugs. Errors are shown in a red box at the top of each window; tray → Developer tools opens the console.
- Only `.glb` (self-contained) files. Auto-skinning is basic; use Blender for production rigs.
- Face expressions work only if the GLB has morph targets named like smile / sad / surprised.
- Voice, LLM, chat window: phase 2.
