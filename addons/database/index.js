'use strict';
// ADO.NET through PowerShell: no database drivers are bundled; whatever Windows already has (SQL Server, ODBC, OLE DB) works.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KINDS = {
  sqlserver: ['System.Data.SqlClient.SqlConnection', 'System.Data.SqlClient.SqlDataAdapter'],
  odbc: ['System.Data.Odbc.OdbcConnection', 'System.Data.Odbc.OdbcDataAdapter'],
  oledb: ['System.Data.OleDb.OleDbConnection', 'System.Data.OleDb.OleDbDataAdapter'],
};
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const dec = (b) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b}'))`;

function runPs(script) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Databases need Windows.'));
  const f = path.join(os.tmpdir(), `saeed-db-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(f, '\ufeff' + script, 'utf8');
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f],
    { windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => { fs.rm(f, { force: true }, () => {}); if (e) reject(new Error(String(err || e.message).trim().slice(0, 500))); else resolve(String(out).trim()); }));
}

async function connection(name, ctx) {
  const lines = String(ctx.settings.connections || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    const [n, kind, ...rest] = l.split('|').map((x) => x.trim());
    if (n.toLowerCase() === String(name).toLowerCase()) {
      if (!KINDS[kind]) throw new Error(`Connection "${n}": kind must be sqlserver, odbc or oledb.`);
      let cs = rest.join('|');
      for (const m of [...cs.matchAll(/\{\{secret:([^}]+)\}\}/g)]) cs = cs.replace(m[0], (await ctx.secret(m[1])) || '');
      return { name: n, kind, cs };
    }
  }
  throw new Error(`There is no connection called "${name}". Set it up in the add-on settings.`);
}
const open = (c) => `$ErrorActionPreference = 'Stop'
$conn = New-Object ${KINDS[c.kind][0]} (${dec(b64(c.cs))})
$conn.Open()`;

// One statement only, and read-only for query.
function check(sql, write) {
  const s = String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--.*$/gm, ' ').trim().replace(/;+\s*$/, '');
  if (!s) throw new Error('Empty statement.');
  if (/;/.test(s)) throw new Error('Only one statement at a time.');
  if (write) { if (!/^(insert|update|delete)\b/i.test(s)) throw new Error('execute only runs INSERT, UPDATE or DELETE.'); if (/^(update|delete)\b/i.test(s) && !/\bwhere\b/i.test(s)) throw new Error('UPDATE and DELETE need a WHERE condition.'); }
  else if (!/^(select|with)\b/i.test(s) || /\b(insert|update|delete|drop|alter|create|truncate|merge|exec|execute|grant|revoke|into)\b/i.test(s.replace(/'[^']*'/g, "''"))) throw new Error('query only runs a read-only SELECT. Use execute for changes.');
  return s;
}

module.exports = {
  tools: {
    async connections(_a, ctx) { return String(ctx.settings.connections || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const p = l.split('|').map((x) => x.trim()); return { name: p[0], kind: p[1] }; }); },
    async tables({ connection: name, table }, ctx) {
      const c = await connection(name, ctx);
      const body = table ? `$t = $conn.GetSchema('Columns', @($null, $null, ${"'" + String(table).replace(/'/g, "''") + "'"})); $t | ForEach-Object { [pscustomobject]@{ column = $_.COLUMN_NAME; type = $_.DATA_TYPE; nullable = $_.IS_NULLABLE } }`
        : "$t = $conn.GetSchema('Tables'); $t | Where-Object { $_.TABLE_TYPE -notlike '*SYSTEM*' } | ForEach-Object { [pscustomobject]@{ table = $_.TABLE_NAME; type = $_.TABLE_TYPE } }";
      const out = await runPs(`${open(c)}\n${body} | Select-Object -First 500 | ConvertTo-Json -Compress\n$conn.Close()`);
      return out || '[]';
    },
    async query({ connection: name, sql, maxRows = 200 }, ctx) {
      const c = await connection(name, ctx), s = check(sql, false), max = Math.max(1, Math.min(2000, Number(maxRows) || 200));
      return runPs(`${open(c)}
$cmd = $conn.CreateCommand(); $cmd.CommandText = ${dec(b64(s))}; $cmd.CommandTimeout = 60
$da = New-Object ${KINDS[c.kind][1]} $cmd
$dt = New-Object System.Data.DataTable
[void]$da.Fill($dt)
$conn.Close()
$cols = @($dt.Columns | ForEach-Object { $_.ColumnName })
$rows = @($dt.Rows | Select-Object -First ${max} | ForEach-Object { $r = $_; $o = [ordered]@{}; foreach ($k in $cols) { $o[$k] = if ($r[$k] -is [DBNull]) { $null } else { $r[$k] } }; $o })
@{ columns = $cols; totalRows = $dt.Rows.Count; shown = $rows.Count; rows = $rows } | ConvertTo-Json -Depth 4 -Compress`);
    },
    async execute({ connection: name, sql }, ctx) {
      const c = await connection(name, ctx), s = check(sql, true);
      return `Rows affected: ${await runPs(`${open(c)}
$cmd = $conn.CreateCommand(); $cmd.CommandText = ${dec(b64(s))}; $cmd.CommandTimeout = 60
$n = $cmd.ExecuteNonQuery(); $conn.Close(); $n`)}`;
    },
  },
  _test: { check },
};
