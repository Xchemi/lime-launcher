const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeImage } = require('electron');
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawn, execFile } = require('child_process');
const AdmZip = require('adm-zip'), os = require('os'), net = require('net');
const { autoUpdater } = require('electron-updater');
const ROOT = path.join(app.getPath('appData'), '.limelauncher'), P = (...a) => path.join(ROOT, ...a);
const UA = { 'User-Agent': 'LimeLauncher/1.0' };
let win;
let lastLog = '';
const send = (c, d) => { if (c === 'log') lastLog = (lastLog + d).slice(-200000); win && win.webContents.send(c, d) }, prog = (t, p) => send('progress', { t, p });
const rj = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } };
const wj = (p, d) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(d)) };
const J = async (u, o = {}) => { const r = await fetch(u, { headers: UA, ...o }); if (!r.ok) throw new Error(r.status + ' ' + u); return r.json() };
const POST = (u, b) => J(u, { method: 'POST', headers: { ...UA, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
async function dl(url, dest) {
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(r.status + ' ' + url);
  fs.writeFileSync(dest + '.part', Buffer.from(await r.arrayBuffer())); fs.renameSync(dest + '.part', dest);
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k) } })) }
const run = (cmd, args, cwd) => new Promise((res, rej) => {
  const c = spawn(cmd, args, { cwd });
  c.stdout.on('data', d => send('log', d + '')); c.stderr.on('data', d => send('log', d + ''));
  c.on('error', rej); c.on('close', k => k ? rej(new Error('Java завершилась с кодом ' + k)) : res());
});
const allow = rules => { if (!rules) return true; let a = false; for (const r of rules) { const m = (!r.os || (r.os.name === 'windows' && (!r.os.arch || r.os.arch === 'x64'))) && !r.features; if (m) a = r.action === 'allow' } return a };
const off = n => { const h = crypto.createHash('md5').update('OfflinePlayer:' + n).digest(); h[6] = h[6] & 15 | 48; h[8] = h[8] & 63 | 128; return h.toString('hex') };
const VM = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

async function ensureVanilla(mc) {
  const f = P('versions', mc, mc + '.json');
  if (!fs.existsSync(f)) { const m = await J(VM); const e = m.versions.find(v => v.id === mc); if (!e) throw new Error('Нет версии ' + mc); wj(f, await J(e.url)) }
  await dl(rj(f).downloads.client.url, P('versions', mc, mc + '.jar'));
  return rj(f);
}
async function ensureJava(base, custom) {
  if (custom && custom !== 'java') return custom;
  try {
    const comp = base.javaVersion?.component || 'jre-legacy', dir = P('runtime', comp), exe = path.join(dir, 'bin', 'java.exe');
    if (fs.existsSync(path.join(dir, '.ok'))) return exe;
    prog('Java…', 0);
    const all = await J('https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json');
    const mf = await J(all['windows-x64'][comp][0].manifest.url);
    const files = Object.entries(mf.files).filter(([, f]) => f.type === 'file'); let n = 0;
    await pool(files, 12, async ([rel, f]) => { await dl(f.downloads.raw.url, path.join(dir, rel)); if (++n % 20 === 0) prog('Java', n / files.length * 100) });
    fs.writeFileSync(path.join(dir, '.ok'), '1'); return exe;
  } catch (er) { send('log', 'Не удалось скачать Java: ' + er.message + ' — использую системную\n'); return 'java'; }
}
async function ensureLoader(p, java) {
  await ensureVanilla(p.mc);
  if (p.loader === 'vanilla') return p.mc;
  if (p.loader === 'fabric') {
    const l = (await J(`https://meta.fabricmc.net/v2/versions/loader/${p.mc}`))[0].loader.version;
    const j = await J(`https://meta.fabricmc.net/v2/versions/loader/${p.mc}/${l}/profile/json`);
    wj(P('versions', j.id, j.id + '.json'), j); return j.id;
  }
  const mark = P('loaders', `${p.loader}-${p.mc}.txt`);
  if (fs.existsSync(mark)) return fs.readFileSync(mark, 'utf8');
  let url;
  if (p.loader === 'forge') {
    const pr = (await J('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json')).promos;
    const v = pr[p.mc + '-recommended'] || pr[p.mc + '-latest']; if (!v) throw new Error('Forge недоступен для ' + p.mc);
    url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${p.mc}-${v}/forge-${p.mc}-${v}-installer.jar`;
  } else {
    const t = p.mc.split('.'), pre = t[0] === '1' ? `${t[1]}.${t[2] || 0}.` : `${t[0]}.${t[1] || 0}.`;
    const l = (await J('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions.filter(x => x.startsWith(pre));
    const v = l.filter(x => !x.includes('beta')).pop() || l.pop(); if (!v) throw new Error('NeoForge недоступен для ' + p.mc);
    url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/neoforge-${v}-installer.jar`;
  }
  const inst = P('loaders', path.basename(url)); await dl(url, inst);
  if (!fs.existsSync(P('launcher_profiles.json'))) wj(P('launcher_profiles.json'), { profiles: {} });
  const before = new Set(fs.readdirSync(P('versions')));
  prog('Установка ' + p.loader + '…', 50);
  await run(java, ['-jar', inst, '--installClient', ROOT], ROOT);
  const id = fs.readdirSync(P('versions')).find(d => !before.has(d)) || fs.readdirSync(P('versions')).find(d => d.toLowerCase().includes(p.loader) && d.includes(p.mc.split('.').slice(0, 2).join('.')) || d.startsWith(p.loader));
  if (!id) throw new Error('Не удалось установить ' + p.loader);
  fs.writeFileSync(mark, id); return id;
}
function load(id) {
  const j = rj(P('versions', id, id + '.json'));
  if (!j.inheritsFrom) { j._base = id; return j }
  const b = load(j.inheritsFrom), a = k => [...(b.arguments?.[k] || []), ...(j.arguments?.[k] || [])];
  return { ...b, ...j, libraries: [...j.libraries, ...b.libraries], arguments: { game: a('game'), jvm: a('jvm') }, _base: b._base };
}
async function installMod(prof, pid, seen = new Set(), type = 'mod') {
  if (seen.has(pid)) return; seen.add(pid);
  const q = new URLSearchParams({ game_versions: JSON.stringify([prof.mc]) });
  if (type === 'mod' && prof.loader !== 'vanilla') q.set('loaders', JSON.stringify([prof.loader]));
  const vs = await J(`https://api.modrinth.com/v2/project/${pid}/version?${q}`);
  if (!vs.length) throw new Error(`Нет версии мода для ${prof.mc} / ${prof.loader}`);
  const f = vs[0].files.find(x => x.primary) || vs[0].files[0];
  await dl(f.url, P('instances', prof.name, type === 'shader' ? 'shaderpacks' : type === 'resourcepack' ? 'resourcepacks' : 'mods', f.filename));
  send('log', 'Мод установлен: ' + f.filename + '\n');
  if (type === 'mod') for (const d of vs[0].dependencies) if (d.dependency_type === 'required') {
    let id = d.project_id; if (!id && d.version_id) id = (await J(`https://api.modrinth.com/v2/version/${d.version_id}`)).project_id;
    if (id) try { await installMod(prof, id, seen) } catch { send('log', 'Зависимость недоступна: ' + id + '\n') }
  }
  return seen.size;
}

ipcMain.handle('get', () => rj(P('state.json')) || {});
ipcMain.handle('set', (e, s) => wj(P('state.json'), s));
ipcMain.handle('versions', async () => { const r = (await J(VM)).versions.filter(v => v.type === 'release').map(v => v.id); return r.slice(0, r.indexOf('1.16') + 1) });
ipcMain.handle('search', (e, { q, mc, loader, cat, type = 'mod' }) => {
  const f = [['project_type:' + type]]; if (mc) f.push([`versions:${mc}`]);
  if (type === 'mod' && loader && loader !== 'vanilla') f.push([`categories:${loader}`]); if (type === 'mod' && cat) f.push([`categories:${cat}`]);
  return J('https://api.modrinth.com/v2/search?' + new URLSearchParams({ query: q || '', facets: JSON.stringify(f), limit: '24', index: q ? 'relevance' : 'downloads' }));
});
ipcMain.handle('mod', (e, { prof, id, type }) => installMod(prof, id, new Set(), type));
ipcMain.handle('folder', (e, n) => { fs.mkdirSync(P('instances', n), { recursive: true }); shell.openPath(P('instances', n)) });
ipcMain.handle('ely', async (e, { u, p }) => {
  const ct = crypto.randomUUID(), r = await POST('https://authserver.ely.by/auth/authenticate', { username: u, password: p, clientToken: ct, requestUser: true });
  return { accessToken: r.accessToken, clientToken: ct, name: r.selectedProfile.name };
});
ipcMain.handle('play', async (e, { prof, server, st }) => {
  try {
    lastLog = '';
    const s = st.settings, gd = P('instances', prof.name); fs.mkdirSync(gd, { recursive: true });
    const base = await ensureVanilla(prof.mc), java = await ensureJava(base, s.java);
    const id = await ensureLoader(prof, java), j = load(id), nat = P('natives', id); fs.mkdirSync(nat, { recursive: true });
    const seen = new Set(), libs = [], cp = []; let n = 0;
    for (const l of j.libraries) { if (!allow(l.rules)) continue; const k = l.name.split(':'), key = k[0] + k[1] + (k[3] || ''); if (!seen.has(key)) { seen.add(key); libs.push(l) } }
    await pool(libs, 8, async (l, i) => {
      const a = l.downloads?.artifact; let rel, url;
      if (a) { rel = a.path; url = a.url } else { const [g, ar, v, c] = l.name.split(':'); rel = `${g.replace(/\./g, '/')}/${ar}/${v}/${ar}-${v}${c ? '-' + c : ''}.jar`; url = (l.url || 'https://libraries.minecraft.net/') + rel }
      const f = P('libraries', rel); if (url) await dl(url, f); if (fs.existsSync(f)) cp[i] = f;
      const nk = l.natives?.windows, c = nk && l.downloads?.classifiers?.[nk.replace('${arch}', '64')];
      if (c) { const nf = P('libraries', c.path); await dl(c.url, nf); new AdmZip(nf).getEntries().forEach(x => { if (!x.isDirectory && !x.entryName.startsWith('META-INF')) fs.writeFileSync(path.join(nat, path.basename(x.entryName)), x.getData()) }) }
      prog('Библиотеки', ++n / libs.length * 100);
    });
    const idx = P('assets', 'indexes', j.assetIndex.id + '.json'); await dl(j.assetIndex.url, idx);
    const objs = Object.values(rj(idx).objects); n = 0;
    await pool(objs, 16, async o => { await dl(`https://resources.download.minecraft.net/${o.hash.slice(0, 2)}/${o.hash}`, P('assets', 'objects', o.hash.slice(0, 2), o.hash)); if (++n % 40 === 0) prog('Ресурсы', n / objs.length * 100) });
    let name = s.nick, uuid = off(s.nick), tok = '0', ut = 'legacy', jv = [];
    if (s.mode === 'ely' && s.ely) {
      prog('Вход Ely.by…', 100);
      const r = await POST('https://authserver.ely.by/auth/refresh', { accessToken: s.ely.accessToken, clientToken: s.ely.clientToken });
      name = r.selectedProfile.name; uuid = r.selectedProfile.id; tok = r.accessToken; ut = 'mojang';
      send('ely', { ...s.ely, accessToken: tok });
      await dl((await J('https://authlib-injector.yushi.moe/artifact/latest.json')).download_url, P('authlib-injector.jar'));
      jv.push(`-javaagent:${P('authlib-injector.jar')}=ely.by`);
    }
    const CP = [...cp.filter(Boolean), P('versions', j._base, j._base + '.jar')].join(';');
    const v = { auth_player_name: name, version_name: id, game_directory: gd, assets_root: P('assets'), assets_index_name: j.assetIndex.id, auth_uuid: uuid, auth_access_token: tok, user_type: ut, version_type: 'LimeLauncher', natives_directory: nat, launcher_name: 'LimeLauncher', launcher_version: '1.0', classpath: CP, library_directory: P('libraries'), classpath_separator: ';', clientid: '0', auth_xuid: '0', user_properties: '{}', auth_session: '0' };
    const sub = a => a.replace(/\$\{(\w+)\}/g, (m, k) => k in v ? v[k] : m);
    const flat = a => (a || []).flatMap(x => typeof x === 'string' ? [x] : allow(x.rules) ? [].concat(x.value) : []).map(sub);
    const game = flat(j.arguments.game);
    if (server) { const [h, p = '25565'] = server.split(':'); game.push(...((prof.mc.split('.')[0] !== '1' || +prof.mc.split('.')[1] >= 20) ? ['--quickPlayMultiplayer', server] : ['--server', h, '--port', p])) }
    const args = [`-Xmx${s.ram}M`, ...(s.jvm || '').split(/\s+/).filter(Boolean), ...jv, ...flat(j.arguments.jvm), j.mainClass, ...game];
    prog('Игра запущена', 100); send('log', `\n▶ ${name} → ${id}\n`);
    const t0 = Date.now(), c = spawn(java, args, { cwd: gd, windowsHide: true }), cores = os.cpus().length; let lastCpu = null;
    const iv = setInterval(() => execFile('powershell', ['-NoProfile', '-Command', `$p=Get-Process -Id ${c.pid} -ErrorAction SilentlyContinue; if($p){"$($p.CPU.ToString([cultureinfo]::InvariantCulture)) $($p.WorkingSet64)"}`], { windowsHide: true }, (er, o) => {
      const [cpu, ws] = String(o || '').trim().split(' ').map(Number); if (!ws) return;
      const now = Date.now(), pc = lastCpu ? Math.max(0, Math.min(100, (cpu - lastCpu[0]) / ((now - lastCpu[1]) / 1000) / cores * 100)) : 0; lastCpu = [cpu, now];
      send('stat', { cpu: Math.round(pc), ram: Math.round(ws / 1048576) });
    }), 3000);
    c.stdout.on('data', d => send('log', d + '')); c.stderr.on('data', d => send('log', d + ''));
    c.on('error', er => send('log', 'Java не найдена: ' + er.message + '\n'));
    c.on('close', k => { clearInterval(iv); send('played', { name: prof.name, ms: Date.now() - t0 }); prog('Игра закрыта (код ' + k + ')', 0) });
  } catch (er) { send('log', '\n✖ ' + er.message + '\n'); prog('Ошибка', 0) }
});
const sha1 = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
ipcMain.handle('open', (e, u) => { if (/^https:\/\/(github\.com\/Xchemi\/lime-launcher|t\.me\/limelauncher|modrinth\.com\/(mod|shader|resourcepack)\/[\w-]+$)/.test(u)) shell.openExternal(u) });
ipcMain.handle('update', async () => { try { const r = await J('https://api.github.com/repos/Xchemi/lime-launcher/releases/latest'), n = s => +String(s).split('.').pop(); if (n(r.tag_name) > n(app.getVersion())) return { v: r.tag_name, url: r.html_url } } catch { } return null });
ipcMain.handle('shots', (e, n) => { const d = P('instances', n, 'screenshots'); try { return fs.readdirSync(d).filter(f => /\.(png|jpe?g)$/i.test(f)).map(f => path.join(d, f)).sort().reverse().slice(0, 60) } catch { return [] } });
ipcMain.handle('shotact', (e, { f, a }) => { if (!f.startsWith(P('instances'))) return; a === 'copy' ? clipboard.writeImage(nativeImage.createFromPath(f)) : shell.showItemInFolder(f) });
ipcMain.handle('import', async (e, existing) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: path.join(app.getPath('appData'), '.minecraft') });
  if (r.canceled) return null;
  const src = r.filePaths[0], base = path.basename(src).replace(/[^\w\- а-яА-Я]/g, '').trim() || 'import'; let name = base, k = 2;
  while (existing.includes(name)) name = base + k++;
  const dst = P('instances', name);
  for (const d of ['mods', 'saves', 'config', 'resourcepacks', 'shaderpacks', 'screenshots', 'options.txt', 'servers.dat']) if (fs.existsSync(path.join(src, d))) fs.cpSync(path.join(src, d), path.join(dst, d), { recursive: true });
  let mc = '', loader = 'vanilla'; const vd = path.join(src, 'versions');
  if (fs.existsSync(vd)) for (const v of fs.readdirSync(vd)) { const x = v.match(/\b(1\.\d{1,2}(?:\.\d+)?|2\d\.\d+(?:\.\d+)?)\b/); if (x) { mc = x[1]; loader = /neoforge/i.test(v) ? 'neoforge' : /forge/i.test(v) ? 'forge' : /fabric/i.test(v) ? 'fabric' : 'vanilla'; if (loader !== 'vanilla') break } }
  return { name, mc, loader };
});
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'forge', 'neoforge', 'fml', 'javafml', 'lowcodefml', 'mixin']);
function readMod(f) {
  const z = new AdmZip(f); let id = '', name = path.basename(f), version = '', deps = [], prov = [], desc = '', authors = '', icon = '';
  const png = en => en && en.header.size < 90000 ? 'data:image/png;base64,' + en.getData().toString('base64') : '';
  const fj = z.getEntry('fabric.mod.json');
  if (fj) { try { const j = JSON.parse(fj.getData().toString('utf8').replace(/^\uFEFF/, '')); id = j.id; name = j.name || j.id; version = j.version; deps = Object.keys(j.depends || {}); prov = (j.provides || []).filter(x => typeof x === 'string');
    desc = j.description || ''; authors = (j.authors || []).map(a => a.name || a).join(', ');
    const ip = typeof j.icon === 'string' ? j.icon : j.icon && j.icon[Object.keys(j.icon).sort((a, b) => b - a)[0]]; icon = png(ip && z.getEntry(ip)) } catch { } }
  else {
    const t = z.getEntry('META-INF/neoforge.mods.toml') || z.getEntry('META-INF/mods.toml');
    if (t) {
      const s = t.getData().toString('utf8'); id = (s.match(/modId\s*=\s*"([^"]+)"/) || [])[1] || ''; name = (s.match(/displayName\s*=\s*"([^"]+)"/) || [])[1] || id; version = (s.match(/^version\s*=\s*"([^"]+)"/m) || [])[1] || '';
      desc = ((s.match(/description\s*=\s*'''([\s\S]*?)'''/) || s.match(/description\s*=\s*"([^"]*)"/) || [])[1] || '').trim(); authors = (s.match(/authors\s*=\s*"([^"]+)"/) || [])[1] || ''; const lf = (s.match(/logoFile\s*=\s*"([^"]+)"/) || [])[1]; icon = png(lf && z.getEntry(lf));
      for (const b of s.split(/\[\[dependencies\.[^\]]+\]\]/).slice(1)) { const d = (b.match(/modId\s*=\s*"([^"]+)"/) || [])[1]; if (d && /mandatory\s*=\s*true|type\s*=\s*"required"/i.test(b)) deps.push(d) }
    }
  }
  return { id: id || path.basename(f), name, version, deps: deps.filter(d => !BUILTIN.has(d)), prov, desc, authors, icon };
}
function listMods(gd) {
  const dir = path.join(gd, 'mods'); let files = [];
  try { files = fs.readdirSync(dir).filter(f => /\.jar(\.disabled)?$/i.test(f)) } catch { return [] }
  const mods = files.map(f => { const en = !f.endsWith('.disabled'); try { return { file: f, enabled: en, ...readMod(path.join(dir, f)) } } catch { return { file: f, enabled: en, id: f, name: f, version: '', deps: [], prov: [] } } });
  const ids = new Set(mods.filter(x => x.enabled).flatMap(x => [x.id, ...x.prov]));
  const has = d => ids.has(d) || (ids.has('fabric-api') && (d === 'fabric' || d.startsWith('fabric-')));
  return mods.map(x => ({ file: x.file, enabled: x.enabled, id: x.id, name: x.name, version: x.version, desc: x.desc, authors: x.authors, icon: x.icon, deps: x.deps, missing: x.enabled ? x.deps.filter(d => !has(d)) : [], needed: mods.filter(o => o.enabled && o !== x && o.deps.some(d => d === x.id || x.prov.includes(d))).map(o => o.name) }));
}
const SIG = [
  ['crit', 'Отправка данных в Discord-вебхук', ['discord.com/api/webhooks', 'discordapp.com/api/webhooks']],
  ['crit', 'Майнер криптовалют', ['stratum+tcp', 'xmrig', 'cryptonight']],
  ['crit', 'Перехват клавиатуры вне игры', ['jnativehook', 'SetWindowsHookEx', 'GetAsyncKeyState']],
  ['warn', 'Доступ к токенам, сессии или данным браузера', ['getAccessToken', 'Login Data', 'discord/Local Storage', 'leveldb', 'Local State']],
  ['warn', 'Запуск процессов и команд ОС', ['ProcessBuilder']],
  ['info', 'Сетевая активность', ['java/net/Socket', 'java/net/URL', 'HttpClient', 'HttpURLConnection']],
  ['info', 'Динамическая загрузка кода', ['defineClass', 'URLClassLoader']],
];
async function scanMod(f) {
  const z = new AdmZip(f), hits = {}; let n = 0; const PL = 'Запуск процессов и команд ОС';
  for (const en of z.getEntries()) {
    if (!/\.class$/.test(en.entryName) || n++ > 5000) continue;
    const t = en.getData().toString('latin1');
    for (const [lv, label, keys] of SIG) if (keys.some(k => t.includes(k))) (hits[label] = hits[label] || { lv, c: 0 }).c++;
    if (t.includes('java/lang/Runtime') && t.includes('\u0000\u0004exec')) (hits[PL] = hits[PL] || { lv: 'warn', c: 0 }).c++;
  }
  let known = '';
  try { const v = await J('https://api.modrinth.com/v2/version_file/' + sha1(f) + '?algorithm=sha1'); known = (await J('https://api.modrinth.com/v2/project/' + v.project_id)).title } catch { }
  const L = Object.entries(hits), crit = L.some(([, h]) => h.lv === 'crit'), warn = L.some(([, h]) => h.lv === 'warn');
  const verdict = crit ? '❌ Опасно' : warn && !known ? '⚠ Подозрительно' : '✔ Явных признаков нет';
  return { verdict, lines: [known ? '✔ Найден на Modrinth: ' + known : 'ℹ Этого файла нет на Modrinth', ...L.map(([k, h]) => ({ crit: '❌ ', warn: '⚠ ', info: 'ℹ ' }[h.lv]) + k + ' (классов: ' + h.c + ')'), 'Это эвристика, а не антивирус.'] };
}
ipcMain.handle('modlist', (e, n) => listMods(P('instances', n)));
ipcMain.handle('modtoggle', (e, { n, f }) => { const d = P('instances', n, 'mods'), b = path.basename(f); fs.renameSync(path.join(d, b), path.join(d, b.endsWith('.disabled') ? b.slice(0, -9) : b + '.disabled')) });
ipcMain.handle('modscan', (e, { n, f }) => scanMod(path.join(P('instances', n, 'mods'), path.basename(f))));
ipcMain.handle('autotune', async (e, { prof, mode }) => {
  const { screen } = require('electron'), out = [], gd = P('instances', prof.name), gb = os.totalmem() / 2 ** 30, cpu = os.cpus().length;
  let gpu = 'неизвестно', disc = false;
  try { const g = (await app.getGPUInfo('basic')).gpuDevice || [], a = g.find(x => x.active) || g[0]; if (a) { gpu = { 4318: 'NVIDIA', 4098: 'AMD', 32902: 'Intel' }[a.vendorId] || 'GPU'; disc = gpu !== 'Intel' } } catch { }
  const d = screen.getPrimaryDisplay(), weak = !disc || cpu <= 4 || gb < 8, perf = mode === 'perf' || (mode === 'balanced' && weak);
  out.push(`🖥 CPU: ${cpu} потоков, RAM: ${gb.toFixed(1)} ГБ, GPU: ${gpu}${disc ? '' : ' (встроенная)'}, экран ${d.size.width}×${d.size.height} ${d.displayFrequency} Гц`);
  out.push(weak ? '📉 Железо слабое: упор в производительность' : '📈 Железо нормальное');
  const ram = Math.max(2048, Math.min(Math.round(gb * { balanced: .4, perf: .3, quality: .5 }[mode] * 2) * 512, mode === 'quality' ? 12288 : 8192)), jvm = '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+DisableExplicitGC';
  send('fix', { ram, jvm }); out.push(`🔧 Память: ${ram} МБ, параметры JVM обновлены`);
  const of = path.join(gd, 'options.txt'); let o = ''; try { o = fs.readFileSync(of, 'utf8') } catch { }
  const set = (k, v) => { const re = new RegExp('^' + k + ':.*$', 'm'); o = re.test(o) ? o.replace(re, k + ':' + v) : o + (o && !o.endsWith('\n') ? '\n' : '') + k + ':' + v + '\n' };
  set('renderDistance', perf ? 8 : mode === 'quality' ? 16 : 12); set('simulationDistance', perf ? 6 : 10); set('graphicsMode', perf ? 0 : 1); set('maxFps', perf ? 120 : d.displayFrequency || 60);
  fs.mkdirSync(gd, { recursive: true }); fs.writeFileSync(of, o); out.push('🔧 Настройки графики записаны (закройте игру перед запуском)');
  if (perf && prof.loader === 'fabric') for (const s of ['fabric-api', 'sodium', 'lithium', 'ferrite-core', 'immediatelyfast']) { try { await installMod(prof, s); out.push('📦 ' + s) } catch { out.push('⚠ ' + s + ': нет версии для ' + prof.mc) } }
  else if (perf) out.push('ℹ Моды для оптимизации ставятся автоматически только на Fabric');
  return out;
});
ipcMain.handle('modcheck', async (e, { prof }) => {
  const d = P('instances', prof.name, 'mods'); let fl = [];
  try { fl = fs.readdirSync(d).filter(f => f.endsWith('.jar')) } catch { return [] }
  if (!fl.length) return [];
  const hs = Object.fromEntries(fl.map(f => [sha1(path.join(d, f)), f])), body = { hashes: Object.keys(hs), algorithm: 'sha1', game_versions: [prof.mc] };
  if (prof.loader !== 'vanilla') body.loaders = [prof.loader];
  const r = await POST('https://api.modrinth.com/v2/version_files/update', body), out = [];
  for (const [h, v] of Object.entries(r)) { const f = v.files.find(x => x.primary) || v.files[0]; if (f.hashes.sha1 !== h) out.push({ old: hs[h], file: f.filename, url: f.url }) }
  return out;
});
ipcMain.handle('modupdate', async (e, { n, items }) => {
  const d = P('instances', n, 'mods');
  for (const it of items) { await dl(it.url, path.join(d, path.basename(it.file))); if (it.old !== it.file) fs.rmSync(path.join(d, path.basename(it.old)), { force: true }) }
  return items.length;
});
const varint = n => { const b = []; do { let t = n & 127; n >>>= 7; if (n) t |= 128; b.push(t) } while (n); return Buffer.from(b) };
const rdv = (b, o) => { let n = 0, i = 0, c; do { if (o + i >= b.length) return null; c = b[o + i]; n |= (c & 127) << (7 * i); i++ } while (c & 128); return [n, o + i] };
ipcMain.handle('ping', (e, addr) => new Promise(res => {
  const [host, ps = '25565'] = addr.split(':'), port = +ps || 25565, t0 = Date.now(); let buf = Buffer.alloc(0);
  const s = net.connect({ host, port, timeout: 4000 }), done = v => { s.destroy(); res(v) };
  s.on('connect', () => { const h = Buffer.from(host), pk = Buffer.concat([varint(0), varint(765), varint(h.length), h, Buffer.from([port >> 8 & 255, port & 255]), varint(1)]); s.write(Buffer.concat([varint(pk.length), pk, Buffer.from([1, 0])])) });
  s.on('data', d => {
    buf = Buffer.concat([buf, d]); const a = rdv(buf, 0); if (!a || buf.length < a[1] + a[0]) return;
    const b = rdv(buf, a[1]), c = b && rdv(buf, b[1]); if (!c) return done({ ok: false });
    try { const j = JSON.parse(buf.slice(c[1], c[1] + c[0]).toString()); done({ ok: true, ms: Date.now() - t0, online: j.players?.online, max: j.players?.max }) } catch { done({ ok: false }) }
  });
  s.on('error', () => done({ ok: false })); s.on('timeout', () => done({ ok: false }));
}));
ipcMain.handle('skinpick', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'PNG', extensions: ['png'] }] }); if (r.canceled) return null; return { path: r.filePaths[0], data: 'data:image/png;base64,' + fs.readFileSync(r.filePaths[0]).toString('base64') } });
ipcMain.handle('skinapply', async (e, { prof, nick, src }) => {
  const d = P('instances', prof.name, 'CustomSkinLoader', 'LocalSkin', 'skins'); fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(src, path.join(d, nick.replace(/[^\w]/g, '') + '.png'));
  try { await installMod(prof, 'customskinloader'); return true } catch { return false }
});
ipcMain.handle('migrate', async (e, { prof, mc, existing }) => {
  const src = P('instances', prof.name), md = path.join(src, 'mods'); let name = prof.name + ' ' + mc, k = 2; const base = name;
  while (existing.includes(name)) name = base + ' ' + k++;
  const dst = P('instances', name), np = { ...prof, name, mc };
  for (const d of ['saves', 'config', 'resourcepacks', 'shaderpacks', 'options.txt', 'servers.dat']) if (fs.existsSync(path.join(src, d))) fs.cpSync(path.join(src, d), path.join(dst, d), { recursive: true });
  let fl = []; try { fl = fs.readdirSync(md).filter(f => f.endsWith('.jar')) } catch { }
  const hs = Object.fromEntries(fl.map(f => [sha1(path.join(md, f)), f])), ok = [], fail = [], seen = new Set();
  const known = fl.length ? await POST('https://api.modrinth.com/v2/version_files', { hashes: Object.keys(hs), algorithm: 'sha1' }) : {};
  for (const [h, f] of Object.entries(hs)) {
    const v = known[h]; if (!v) { fail.push(f + ' (нет на Modrinth)'); continue }
    try { await installMod(np, v.project_id, seen); ok.push(f) } catch { fail.push(f + ' (нет версии для ' + mc + ')') }
  }
  return { name, ok, fail };
});
ipcMain.handle('modmeta', async (e, n) => {
  const d = P('instances', n, 'mods'); let fl = [];
  try { fl = fs.readdirSync(d).filter(f => /\.jar(\.disabled)?$/i.test(f)) } catch { return {} }
  if (!fl.length) return {};
  const hs = Object.fromEntries(fl.map(f => [sha1(path.join(d, f)), f])), vers = await POST('https://api.modrinth.com/v2/version_files', { hashes: Object.keys(hs), algorithm: 'sha1' });
  const ids = [...new Set(Object.values(vers).map(v => v.project_id))], prj = ids.length ? await J('https://api.modrinth.com/v2/projects?ids=' + encodeURIComponent(JSON.stringify(ids))) : [];
  const by = Object.fromEntries(prj.map(p => [p.id, p])), out = {};
  for (const [h, v] of Object.entries(vers)) { const p = by[v.project_id]; if (p) out[hs[h]] = { title: p.title, desc: p.description, icon: p.icon_url, slug: p.slug } }
  return out;
});
ipcMain.handle('addjarpaths', (e, { n, paths }) => { const d = P('instances', n, 'mods'); fs.mkdirSync(d, { recursive: true }); paths.filter(f => /\.jar$/i.test(f)).forEach(f => fs.copyFileSync(f, path.join(d, path.basename(f)))); return paths.length });
ipcMain.handle('tg', () => shell.openExternal('https://t.me/limelauncher'));
ipcMain.handle('addjars', async (e, n) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Minecraft mods', extensions: ['jar'] }] });
  if (r.canceled) return 0;
  const d = P('instances', n, 'mods'); fs.mkdirSync(d, { recursive: true });
  r.filePaths.forEach(f => fs.copyFileSync(f, path.join(d, path.basename(f)))); return r.filePaths.length;
});
ipcMain.handle('diagnose', async (e, { prof, st }) => {
  let suspects = [];
  const out = [], s = st.settings, gd = P('instances', prof.name);
  const ok = t => out.push('✔ ' + t), bad = t => out.push('✖ ' + t), fx = t => out.push('🔧 ' + t);
  try {
    if (s.java && s.java !== 'java' && !fs.existsSync(s.java)) { bad('Указанная Java не найдена: ' + s.java); send('fix', { java: 'java' }); fx('Включил автоматическую Java') } else ok('Java: ' + (s.java === 'java' ? 'автоматическая' : s.java));
    let n = 0;
    for (const d of ['libraries', 'versions']) if (fs.existsSync(P(d))) for (const f of fs.readdirSync(P(d), { recursive: true })) if (String(f).endsWith('.part')) { fs.rmSync(P(d, f), { force: true }); n++ }
    n ? fx('Удалено недокачанных файлов: ' + n) : ok('Недокачанных файлов нет');
    const base = await ensureVanilla(prof.mc), java = await ensureJava(base, s.java), id = await ensureLoader(prof, java), j = load(id);
    ok('Версия ' + id + ' установлена'); n = 0;
    const chk = (f, h) => { if (h && fs.existsSync(f) && sha1(f) !== h) { fs.rmSync(f, { force: true }); n++ } };
    chk(P('versions', prof.mc, prof.mc + '.jar'), base.downloads.client.sha1);
    for (const l of j.libraries) { const a = l.downloads?.artifact; if (a) chk(P('libraries', a.path), a.sha1) }
    n ? fx('Повреждённых файлов удалено: ' + n + ' (скачаются заново при запуске)') : ok('Файлы игры целы');
    const mods = listMods(gd), miss = [...new Set(mods.filter(x => x.enabled).flatMap(x => x.missing))];
    for (const d of miss) { try { await installMod(prof, d); fx('Не хватало зависимости ' + d + ': установил') } catch { bad('Не хватает зависимости ' + d + ' (не найдена на Modrinth)') } }
    if (!miss.length) ok('Зависимости модов на месте');
    let log = lastLog;
    for (const f of [['logs', 'latest.log'], ['fabricloader.log']]) try { log += fs.readFileSync(path.join(gd, ...f), 'utf8').slice(-80000) } catch { }
    const has = re => re.test(log); let hit = false;
    if (has(/error remapping game jars|remappedJars/i)) { hit = true; fs.rmSync(path.join(gd, '.fabric'), { recursive: true, force: true }); fx('Причина: повреждён кэш Fabric. Очистил, запустите снова') }
    if (has(/UnsupportedClassVersionError|class file version/i)) { hit = true; send('fix', { java: 'java' }); fx('Причина: не та версия Java. Включил автоматическую Java') }
    if (has(/OutOfMemoryError/i)) { hit = true; const r = Math.min(s.ram + 2048, 16384); send('fix', { ram: r }); fx('Причина: не хватает памяти. Увеличил до ' + r + ' МБ') }
    if (has(/Could not reserve enough space|Invalid maximum heap size/i)) { hit = true; send('fix', { ram: 3072 }); fx('Причина: выделено больше памяти, чем есть. Поставил 3072 МБ') }
    if (has(/requires[^\n]*fabric-api/i)) { hit = true; await installMod(prof, 'P7dR8mSH'); fx('Причина: нет Fabric API. Установил') }
    if (has(/Incompatible mods found|Mod resolution failed|which is missing/i)) { hit = true; bad('Конфликт модов:'); log.split('\n').filter(l => /requires|incompatible|conflict|missing/i.test(l)).slice(0, 5).forEach(l => out.push('   ' + l.trim().slice(0, 200))); out.push('   Удалите или обновите эти моды (кнопка «Папка» в Сборках)') }
    if (has(/Mixin apply failed|InvalidMixinException|MixinTransformerError/i)) { hit = true; bad('Какой-то мод не подходит к этой версии игры. Уберите последний добавленный мод') }
    if (has(/Access is denied|being used by another process/i)) { hit = true; bad('Файл занят другой программой. Закройте другие копии Minecraft и антивирус-сканирование') }
    if (has(/UnknownHostException|Connection reset|timed out/i)) { hit = true; bad('Проблемы с интернетом при загрузке файлов. Проверьте соединение и повторите') }
    const crash = (() => { try { const cd = path.join(gd, 'crash-reports'), fl = fs.readdirSync(cd).sort().reverse(); return fl[0] ? fs.readFileSync(path.join(cd, fl[0]), 'utf8') : '' } catch { return '' } })();
    const errT = crash + '\n' + log.split('\n').filter(l => /Exception|Caused by|Mixin|^\s+at /i.test(l)).slice(-250).join('\n');
    suspects = mods.filter(x => x.enabled && !/^(fabric-|fabricloader|minecraft|java)/.test(x.id) && (errT.includes('(' + x.id + ')') || errT.includes('.' + x.id.replace(/-/g, '_') + '.') || errT.includes(x.id + '.mixins.json')));
    if (suspects.length) { hit = true; bad('Краш связан с модами: ' + suspects.map(x => x.name).join(', ')) }
    if (!hit) out.push(log.trim() ? 'ℹ Явных причин в журнале не найдено. Запустите игру ещё раз; если не поможет, пришлите журнал автору' : 'ℹ Журнал пуст. Сначала нажмите ИГРАТЬ, а после сбоя «Починить»');
  } catch (er) { bad('Диагностика не удалась: ' + er.message) }
  return { out, suspects: suspects.map(x => ({ file: x.file, name: x.name })) };
});
app.whenReady().then(() => {
  win = new BrowserWindow({ width: 1120, height: 720, minWidth: 900, minHeight: 600, autoHideMenuBar: true, backgroundColor: '#ffffff', title: 'Lime Launcher', icon: path.join(__dirname, 'icon.png'), webPreferences: { nodeIntegration: true, contextIsolation: false } });
  win.loadFile('index.html');
  if (app.isPackaged) {
    autoUpdater.on('update-available', i => send('upd', { s: 'dl', v: i.version }));
    autoUpdater.on('update-downloaded', i => send('upd', { s: 'ready', v: i.version }));
    autoUpdater.on('error', er => send('log', 'Обновление: ' + er.message + '\n'));
    autoUpdater.checkForUpdates().catch(() => { });
  }
});
ipcMain.handle('restart', () => autoUpdater.quitAndInstall());
app.on('window-all-closed', () => app.quit());
