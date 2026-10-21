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


/* ---------- UI Automation: work with the controls of a program without looking at the screen ---------- */
const UIA = `Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
function Find-Win($title) {
  if (-not $title) { return $AE::FromHandle([W]::GetForegroundWindow()) }
  foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) { if ($w.Current.Name -like "*$title*") { return $w } }
  throw "Window not found: $title"
}
function Check-Win($w) { $n = $w.Current.Name.ToLower(); foreach ($p in $blocked) { if ($p -and $n.Contains($p.ToLower())) { throw "Blocked window: $($w.Current.Name)" } } }
function Find-Control($win, $name, $aid) {
  $conds = @()
  if ($name) { $conds += New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name) }
  if ($aid) { $conds += New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $aid) }
  if ($conds.Count -eq 0) { throw 'Give a name or an automationId.' }
  $cond = if ($conds.Count -gt 1) { New-Object System.Windows.Automation.AndCondition($conds) } else { $conds[0] }
  $el = $win.FindFirst($TS::Descendants, $cond)
  if (-not $el -and $name) { foreach ($c in $win.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if ($c.Current.Name -like "*$name*") { $el = $c; break } } }
  if (-not $el) { throw 'Control not found. Use ui_tree to see the names.' }
  return $el
}
function Get-Val($el) {
  try { return $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
  try { return $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(4000) } catch {}
  return $null
}
`;
const uiaRun = (settings, body) => runPs(`${PRELUDE}\n$blocked = @(${list(settings.blocked).map(q).join(',')})\n${UIA}\n${body}`, 60000);
const b64 = (t) => Buffer.from(String(t ?? ''), 'utf8').toString('base64');
const decl = (v, t) => `$${v} = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(t)}'))`;
const target = (a) => `${decl('title', a.window)}\n${decl('name', a.name)}\n${decl('aid', a.automationId)}\n$win = Find-Win $title\nCheck-Win $win\n`;

const SENDKEYS_SPECIAL = /[+^%~(){}[\]]/g;
// SendKeys treats + ^ % ~ ( ) { } [ ] as control characters; wrap each in braces so arbitrary typed text (dates, IDs, names) goes in literally.
function escapeTypedText(s) { return String(s).replace(SENDKEYS_SPECIAL, (c) => `{${c}}`); }
const uiaTools = {
  async ui_tree(a, ctx) {
    const depth = Math.max(1, Math.min(6, Number(a.depth) || 3));
    return uiaRun(ctx.settings, `${decl('title', a.window)}
$win = Find-Win $title
Check-Win $win
$script:out = @(); $script:n = 0
function Walk($el, $d) {
  if ($script:n -ge 250) { return }
  $script:n++
  $c = $el.Current
  $script:out += [pscustomobject]@{ d = $d; type = $c.ControlType.ProgrammaticName.Replace('ControlType.', ''); name = $c.Name; id = $c.AutomationId; value = (Get-Val $el); enabled = $c.IsEnabled }
  if ($d -lt ${depth}) { foreach ($k in $el.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) { Walk $k ($d + 1) } }
}
Walk $win 0
@{ window = $win.Current.Name; controls = $script:out; truncated = ($script:n -ge 250) } | ConvertTo-Json -Depth 4 -Compress`);
  },
  async ui_read(a, ctx) {
    return uiaRun(ctx.settings, `${target(a)}$el = Find-Control $win $name $aid
$v = Get-Val $el
@{ name = $el.Current.Name; type = $el.Current.ControlType.ProgrammaticName; value = $v; enabled = $el.Current.IsEnabled } | ConvertTo-Json -Compress`);
  },
  async ui_set_text(a, ctx) {
    // Many legacy and browser-hosted forms (old ASP.NET/VB6/MFC windows, Internet Explorer controls) report
    // ValuePattern.SetValue as succeeding without it actually reaching the real field, so this always reads the
    // value back afterward; if it does not match, it falls back to physically clicking the control and typing
    // real keystrokes (SendKeys), which reaches almost anything because it is indistinguishable from a real
    // keyboard - UI Automation is not involved in that path at all.
    return uiaRun(ctx.settings, `${target(a)}${decl('raw', a.text)}${decl('keys', escapeTypedText(a.text))}
$el = Find-Control $win $name $aid
$ok = $false
try {
  $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($raw)
  Start-Sleep -Milliseconds 150
  if ((Get-Val $el) -eq $raw) { $ok = $true }
} catch {}
if (-not $ok) {
  $r = $el.Current.BoundingRectangle
  [void][W]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
  Start-Sleep -Milliseconds 100
  [W]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [W]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
  Start-Sleep -Milliseconds 150
  try { $el.SetFocus() } catch {}
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  Start-Sleep -Milliseconds 60
  [System.Windows.Forms.SendKeys]::SendWait('{DEL}')
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Milliseconds 150
  try { $ok = ((Get-Val $el) -eq $raw) } catch { $ok = $null }
}
$after = $null
try { $after = Get-Val $el } catch {}
if ($ok -eq $true) { "Set \`"$raw\`" (verified it is now in the field)." }
elseif ($after) { "Typed \`"$raw\`" by clicking and typing, but the field now reads \`"$after\`" - check it visually, this program may not report its value through automation." }
else { "Typed \`"$raw\`" by clicking and typing (could not read the field back to verify - check it visually)." }`);
  },
  async ui_select(a, ctx) {
    return uiaRun(ctx.settings, `${target(a)}${decl('opt', a.option)}
$el = Find-Control $win $name $aid
try { $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand() } catch {}
Start-Sleep -Milliseconds 300
$item = $null
$cond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $opt)
$item = $win.FindFirst($TS::Descendants, $cond)
if (-not $item) { foreach ($c in $win.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) { if ($c.Current.Name -like "*$opt*" -and ($c.Current.ControlType.ProgrammaticName -like '*ListItem*' -or $c.Current.ControlType.ProgrammaticName -like '*ComboBoxItem*')) { $item = $c; break } } }
if ($item) {
  $done = $false
  try { $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); $done = $true } catch {}
  if (-not $done) { $r = $item.Current.BoundingRectangle; [void][W]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)); Start-Sleep -Milliseconds 80; [W]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [W]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
  try { $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() } catch {}
  "Chose \`"$opt\`". Current value: $(Get-Val $el)"
} else {
  try { $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() } catch {}
  try { $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($opt); "Typed \`"$opt\`" into the field (it had no matching list item)." }
  catch { throw "No item named \`"$opt\`" was found in this drop-down. Use ui_tree to see the exact text." }
}`);
  },
  async ui_click(a, ctx) {
    return uiaRun(ctx.settings, `${target(a)}$el = Find-Control $win $name $aid
$done = $false
foreach ($p in @([System.Windows.Automation.InvokePattern], [System.Windows.Automation.SelectionItemPattern], [System.Windows.Automation.TogglePattern], [System.Windows.Automation.ExpandCollapsePattern])) {
  try { $pat = $el.GetCurrentPattern($p::Pattern); if ($p -eq [System.Windows.Automation.InvokePattern]) { $pat.Invoke() } elseif ($p -eq [System.Windows.Automation.SelectionItemPattern]) { $pat.Select() } elseif ($p -eq [System.Windows.Automation.TogglePattern]) { $pat.Toggle() } else { $pat.Expand() }; $done = $true; break } catch {}
}
if (-not $done) { $r = $el.Current.BoundingRectangle; [void][W]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)); Start-Sleep -Milliseconds 80; [W]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [W]::mouse_event(4,0,0,0,[UIntPtr]::Zero); 'Clicked at the control.' } else { 'Done.' }`);
  },
  async list_windows(_a, ctx) {
    return uiaRun(ctx.settings, `foreach ($w in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
  if (-not $w.Current.Name) { continue }
  [pscustomobject]@{ title = $w.Current.Name; className = $w.Current.ClassName; minimized = $w.Current.BoundingRectangle.Y -lt -10000 }
} | ConvertTo-Json -Compress`);
  },
  async explore_window(a, ctx) {
    let tree;
    try { tree = await uiaTools.ui_tree(a, ctx); } catch (e) { tree = 'UI Automation failed: ' + e.message; }
    let controlCount = 0;
    try { controlCount = (JSON.parse(tree).controls || []).length; } catch { /* not JSON: treat as empty */ }
    if (controlCount >= 4) return { text: `Read via UI Automation (${controlCount} controls, more reliable than a picture):\n${tree}` };
    const shot = await module.exports.tools.screenshot(a, ctx);
    return { text: `UI Automation found little (${controlCount} controls) in this window, so here is a screenshot instead. Use the "act" tool with pixel coordinates for this program.\n${shot.text}`, image: shot.image };
  },
  async ui_table(a, ctx) {
    const max = Math.max(1, Math.min(500, Number(a.maxRows) || 200));
    return uiaRun(ctx.settings, `${target(a)}$el = Find-Control $win $name $aid
$grid = $null
try { $grid = $el.GetCurrentPattern([System.Windows.Automation.GridPattern]::Pattern) } catch {}
$table = $el.FindAll($TS::Descendants, New-Object System.Windows.Automation.PropertyCondition($AE::IsGridItemPatternAvailableProperty, $true))
$rowsOut = @()
if ($table.Count -gt 0) {
  $byRow = @{}
  foreach ($cell in $table) {
    try { $gi = $cell.GetCurrentPattern([System.Windows.Automation.GridItemPattern]::Pattern) } catch { continue }
    $r = $gi.Current.Row
    if (-not $byRow.ContainsKey($r)) { $byRow[$r] = @{} }
    $byRow[$r][$gi.Current.Column] = (Get-Val $cell)
    if ($byRow[$r][$gi.Current.Column] -eq $null) { $byRow[$r][$gi.Current.Column] = $cell.Current.Name }
  }
  foreach ($r in ($byRow.Keys | Sort-Object)[0..([Math]::Min(${max} - 1, $byRow.Keys.Count - 1))]) {
    $cols = $byRow[$r].Keys | Sort-Object
    $rowsOut += ,(@($cols | ForEach-Object { $byRow[$r][$_] }))
  }
} else {
  foreach ($row in ($el.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) | Select-Object -First ${max})) {
    $rowsOut += ,(@($row.Current.Name))
  }
}
@{ rows = $rowsOut; rowCount = $rowsOut.Count } | ConvertTo-Json -Depth 4 -Compress`);
  },
};

module.exports = {
  tools: {
    ...uiaTools,
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
