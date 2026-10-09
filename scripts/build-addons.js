#!/usr/bin/env node
// Packages every folder in /addons into dist-addons/<id>-<version>.zip (dependencies included)
// and writes registry.json. Run it on Windows x64 so native libraries match the users' PCs.
//   npm run build-addons
// Then: upload the zips to a GitHub release tagged "addons", and commit addons/registry.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');

const root = path.join(__dirname, '..');
const src = path.join(root, 'addons');
const out = path.join(root, 'dist-addons');
const pkg = require(path.join(root, 'package.json'));
const pub = (pkg.build && pkg.build.publish && pkg.build.publish[0]) || {};
const repo = process.env.SAEED_REPO || (pub.owner && pub.repo ? `${pub.owner}/${pub.repo}` : 'OWNER/REPO');
const tag = process.env.ADDONS_TAG || 'addons';

(async () => {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, '.stage'), { recursive: true });
  const entries = [];
  for (const id of fs.readdirSync(src)) {
    const dir = path.join(src, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'addon.json'), 'utf8'));
    const stage = path.join(out, '.stage', id);
    fs.cpSync(dir, stage, { recursive: true });
    if (fs.existsSync(path.join(stage, 'package.json'))) {
      console.log(`[${id}] installing dependencies…`);
      execSync('npm install --omit=dev --no-audit --no-fund', { cwd: stage, stdio: 'inherit' });
      fs.rmSync(path.join(stage, 'package-lock.json'), { force: true });
    }
    if (m.build && m.build.prepare) {
      console.log(`[${id}] preparing…`);
      await require(path.join(stage, m.build.prepare))(stage);
      fs.rmSync(path.join(stage, m.build.prepare), { force: true });
    }
    const zip = new AdmZip();
    zip.addLocalFolder(stage);
    const file = `${id}-${m.version}.zip`;
    zip.writeZip(path.join(out, file));
    const buf = fs.readFileSync(path.join(out, file));
    entries.push({
      id, name: m.name, version: m.version, description: m.description, author: m.author, permissions: m.permissions || [],
      size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      url: `https://github.com/${repo}/releases/download/${tag}/${file}`,
    });
    console.log(`[${id}] ${file}  ${(buf.length / 1048576).toFixed(1)} MB`);
  }
  fs.rmSync(path.join(out, '.stage'), { recursive: true, force: true });
  const json = JSON.stringify({ addons: entries }, null, 2);
  fs.writeFileSync(path.join(out, 'registry.json'), json);
  fs.writeFileSync(path.join(src, 'registry.json'), json);
  console.log(`\nDone. Upload dist-addons/*.zip to the "${tag}" release of ${repo}, then commit addons/registry.json.`);
})().catch((e) => { console.error(e); process.exit(1); });
