// Assembles the static site into public/ (Vercel serves public/ as the site root).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS } from './icons.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { pathToFileURL } from 'node:url';
const ui = path.join(root, 'src/ui');
const out = path.join(root, 'public');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

const icon = (name, cls = '') => {
  if (!(name in ICONS)) throw new Error('Unknown icon: ' + name);
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
};

function render(tpl) {
  let s = tpl;
  for (let i = 0; i < 6; i++) { // resolve nested includes/panels
    s = s
      .replace(/\{\{include:(\w+)\}\}/g, (_, n) => read(ui, 'components', n + '.html'))
      .replace(/\{\{panel:(\w+):([01])\}\}/g, (_, key, idle) => {
        let p = read(ui, 'components/panel.html').replace(/\{\{key\}\}/g, key);
        p = idle === '1' ? p.replace(/\{\{#idle\}\}|\{\{\/idle\}\}/g, '') : p.replace(/\{\{#idle\}\}[\s\S]*?\{\{\/idle\}\}/g, '');
        return p;
      });
  }
  return s
    .replace(/\{\{icon:(\w+)(?::(\w+))?\}\}/g, (_, n, c) => icon(n, c))
    .replace(/\{\{bars:(\d+)\}\}/g, (_, n) => '<i></i>'.repeat(Number(n)))
    .replace(/\{\{version\}\}/g, version);
}

export function buildSite() {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'src/ui'), { recursive: true });
  fs.mkdirSync(path.join(out, 'resources'), { recursive: true });
  const html = render(read(ui, 'index.html'));
  const left = html.match(/\{\{[^}]+\}\}/g);
  if (left) throw new Error('Unresolved template tokens: ' + [...new Set(left)].join(', '));
  fs.writeFileSync(path.join(out, 'index.html'), html);
  for (const f of ['style.css', 'responsive.css', 'animation.css', 'app.js']) fs.copyFileSync(path.join(ui, f), path.join(out, 'src/ui', f));
  fs.copyFileSync(path.join(root, 'resources/mostakim.png'), path.join(out, 'resources/mostakim.png'));
  return { bytes: html.length, version };
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url) {
  const r = buildSite();
  console.log(`built public/ (${(r.bytes / 1024).toFixed(1)} KB html, v${r.version})`);
}
