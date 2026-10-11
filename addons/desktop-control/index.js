'use strict';
// Screen control for Windows with no extra libraries: PowerShell + user32 for screenshots, mouse and keyboard.
// Safety: the permission "Control the screen" is asked per task, a red STOP bar is shown (and hidden from screenshots),
// Ctrl+Alt+X stops everything, and actions are refused while a blocked window (Task Manager, PowerShell...) is in front.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const state = { scale: 1, realW: 0, realH: 0 };
let chain = Promise.resolve();

const PRELUDE = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, int d, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
[void][W]::SetProcessDPIAware()
function Title { $sb = New-Object System.Text.StringBuilder 512; [void][W]::GetWindowText([W]::GetForegroundWindow(), $sb, 512); $sb.ToString() }
`;

function runPs(script, timeout = 60000) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Screen control works on Windows only.'));
  const run = () => new Promise((resolve, reject) => {
    const f = path.join(os.tmpdir(), `saeed-ps-${process.pid}-${Date.now()}.ps1`);
    fs.writeFileSync(f, '\ufeff' + script, 'utf8');
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f],
      { windowsHide: true, timeout, maxBuffer: 80 * 1024 * 1024 },
      (err, stdout, stderr) => { fs.rm(f, { force: true }, () => {}); if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 500))); else resolve(String(stdout).trim()); });
  });
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

async function screenshot(settings) {
  const maxSide = Math.max(480, Math.min(2560, Number(settings.maxSide) || 1280));
  const out = await runPs(`${PRELUDE}
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$s = [Math]::Min(1.0, ${maxSide} / [Math]::Max($b.Width, $b.Height))
$w = [int]($b.Width * $s); $h = [int]($b.Height * $s)
$o = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($o)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $w, $h)
$ms = New-Object System.IO.MemoryStream
$o.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
"$($b.Width) $($b.Height) $w $h|" + (Title) + "|" + [Convert]::ToBase64String($ms.ToArray())
`);
  const i = out.indexOf('|'), j = out.lastIndexOf('|');
  const [rw, rh, w, h] = out.slice(0, i).split(' ').map(Number);
  state.realW = rw; state.realH = rh; state.scale = w / rw;
  return { text: `Screenshot ${w}x${h}. Active window: "${out.slice(i + 1, j)}". Mouse coordinates are pixels of this image.`, image: { mime: 'image/png', data: out.slice(j + 1) } };
}

const SPECIAL = { enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}',
  home: '{HOME}', end: '{END}', pageup: '{PGUP}', pagedown: '{PGDN}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', space: ' ', insert: '{INSERT}' };
function sendKeys(spec) {
  if (String(spec).trim() === '+') return '{+}';
  const parts = String(spec).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const key = parts.pop() || '';
  let mods = '';
  for (const m of parts) {
    if (m === 'ctrl' || m === 'control') mods += '^'; else if (m === 'alt') mods += '%'; else if (m === 'shift') mods += '+';
    else throw new Error('Unsupported modifier: ' + m);
  }
  const k = SPECIAL[key] || (/^f([1-9]|1[0-6])$/.test(key) ? `{${key.toUpperCase()}}` : key.length === 1 ? ('+^%~(){}[]'.includes(key) ? `{${key}}` : key) : '');
  if (!k) throw new Error('Unknown key: ' + spec);
  return mods + k;
}

const BTN = { left: [2, 4], right: [8, 16], middle: [32, 64] };
function buildAct(steps, o) {
  if (!state.realW) throw new Error('Take a screenshot first, so the coordinates are known.');
  const px = (v, max) => Math.max(0, Math.min(max - 1, Math.round(Number(v) / state.scale)));
  const X = (v) => px(v, state.realW), Y = (v) => px(v, state.realH);
  const delay = Math.max(50, Math.min(3000, Number(o.delay) || 250));
  const L = [PRELUDE, `$blocked = @(${list(o.blocked).map(q).join(',')})`,
    'function Chk { $t = (Title).ToLower(); foreach ($p in $blocked) { if ($p -and $t.Contains($p.ToLower())) { throw "Blocked window in front: $(Title)" } } }'];
  for (const s of steps.slice(0, 15)) {
    switch (s.action) {
      case 'click': {
        const [d, u] = BTN[s.button || 'left'] || BTN.left;
        L.push('Chk', `[void][W]::SetCursorPos(${X(s.x)}, ${Y(s.y)}); Start-Sleep -Milliseconds 60`);
        for (let i = 0; i < (s.count === 2 ? 2 : 1); i++) L.push(`[W]::mouse_event(${d},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [W]::mouse_event(${u},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80`);
        break;
      }
      case 'move': L.push('Chk', `[void][W]::SetCursorPos(${X(s.x)}, ${Y(s.y)})`); break;
      case 'drag': {
        const x1 = X(s.x), y1 = Y(s.y), x2 = X(s.x2), y2 = Y(s.y2);
        L.push('Chk', `[void][W]::SetCursorPos(${x1}, ${y1}); Start-Sleep -Milliseconds 80; [W]::mouse_event(2,0,0,0,[UIntPtr]::Zero)`);
        for (let i = 1; i <= 10; i++) L.push(`[void][W]::SetCursorPos(${Math.round(x1 + ((x2 - x1) * i) / 10)}, ${Math.round(y1 + ((y2 - y1) * i) / 10)}); Start-Sleep -Milliseconds 25`);
        L.push('[W]::mouse_event(4,0,0,0,[UIntPtr]::Zero)');
        break;
      }
      case 'scroll':
        L.push('Chk');
        if (s.x != null && s.y != null) L.push(`[void][W]::SetCursorPos(${X(s.x)}, ${Y(s.y)}); Start-Sleep -Milliseconds 60`);
        L.push(`[W]::mouse_event(0x0800,0,0,${-Math.round(Math.max(-30, Math.min(30, Number(s.amount) || 3))) * 120},[UIntPtr]::Zero)`);
        break;
      case 'type': {
        const b64 = Buffer.from(String(s.text || '').slice(0, 4000), 'utf8').toString('base64');
        L.push('Chk', `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
          '$old = $null; try { $old = Get-Clipboard -Raw } catch {}',
          'Set-Clipboard -Value $t; Start-Sleep -Milliseconds 80',
          "[System.Windows.Forms.SendKeys]::SendWait('^v'); Start-Sleep -Milliseconds 150",
          'if ($old) { Set-Clipboard -Value $old }');
        break;
      }
      case 'key': L.push('Chk', `[System.Windows.Forms.SendKeys]::SendWait(${q(sendKeys(s.keys))})`); break;
      case 'wait': L.push(`Start-Sleep -Milliseconds ${Math.max(0, Math.min(10000, Number(s.ms) || 500))}`); break;
      default: throw new Error('Unknown step: ' + s.action);
    }
    L.push(`Start-Sleep -Milliseconds ${delay}`);
  }
  L.push('Title');
  return L.join('\n');
}

module.exports = {
  tools: {
    async screenshot(_a, ctx) { return screenshot(ctx.settings); },
    async act({ steps, screenshot: shot = true }, ctx) {
      if (!Array.isArray(steps) || !steps.length) throw new Error('No steps were given.');
      const title = await runPs(buildAct(steps, ctx.settings), 120000);
      if (shot === false) return `Done ${Math.min(steps.length, 15)} step(s). Active window: "${title}".`;
      const r = await screenshot(ctx.settings);
      return { text: `Done ${Math.min(steps.length, 15)} step(s). ${r.text}`, image: r.image };
    },
    async windows({ action, title }, ctx) {
      if (action === 'focus') {
        if (!title) throw new Error('Give part of the window title.');
        const bad = list(ctx.settings.blocked).find((b) => String(title).toLowerCase().includes(b.toLowerCase()));
        if (bad) throw new Error(`Windows containing "${bad}" are blocked in the add-on settings.`);
        const out = await runPs(`${PRELUDE}\n$ok = (New-Object -ComObject WScript.Shell).AppActivate(${q(title)}); Start-Sleep -Milliseconds 400\n"$ok|" + (Title)`);
        return out.startsWith('True') ? `Brought to the front. Active window: "${out.split('|')[1]}".` : 'No window with that title was found.';
      }
      const out = await runPs(`${PRELUDE}\nGet-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)" }`);
      return out.split('\n').slice(0, 40).join('\n') || 'No windows found.';
    },
  },
  _test: { sendKeys, buildAct, state },
};
