const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const ROOT = path.join(app.getPath('appData'), '.limelauncher'), P = (...a) => path.join(ROOT, ...a);
const UA = { 'User-Agent': 'LimeLauncher/1.0' };
let win;
const send = (c, d) => win && win.webContents.send(c, d), prog = (t, p) => send('progress', { t, p });
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
async function installMod(prof, pid, seen = new Set()) {
  if (seen.has(pid)) return; seen.add(pid);
  const q = new URLSearchParams({ game_versions: JSON.stringify([prof.mc]) });
  if (prof.loader !== 'vanilla') q.set('loaders', JSON.stringify([prof.loader]));
  const vs = await J(`https://api.modrinth.com/v2/project/${pid}/version?${q}`);
  if (!vs.length) throw new Error(`Нет версии мода для ${prof.mc} / ${prof.loader}`);
  const f = vs[0].files.find(x => x.primary) || vs[0].files[0];
  await dl(f.url, P('instances', prof.name, 'mods', f.filename));
  send('log', 'Мод установлен: ' + f.filename + '\n');
  for (const d of vs[0].dependencies) if (d.dependency_type === 'required') {
    let id = d.project_id; if (!id && d.version_id) id = (await J(`https://api.modrinth.com/v2/version/${d.version_id}`)).project_id;
    if (id) await installMod(prof, id, seen);
  }
  return seen.size;
}

ipcMain.handle('get', () => rj(P('state.json')) || {});
ipcMain.handle('set', (e, s) => wj(P('state.json'), s));
ipcMain.handle('versions', async () => { const r = (await J(VM)).versions.filter(v => v.type === 'release').map(v => v.id); return r.slice(0, r.indexOf('1.16') + 1) });
ipcMain.handle('search', (e, { q, mc, loader, cat }) => {
  const f = [['project_type:mod']]; if (mc) f.push([`versions:${mc}`]);
  if (loader && loader !== 'vanilla') f.push([`categories:${loader}`]); if (cat) f.push([`categories:${cat}`]);
  return J('https://api.modrinth.com/v2/search?' + new URLSearchParams({ query: q || '', facets: JSON.stringify(f), limit: '24', index: q ? 'relevance' : 'downloads' }));
});
ipcMain.handle('mod', (e, { prof, id }) => installMod(prof, id));
ipcMain.handle('folder', (e, n) => { fs.mkdirSync(P('instances', n), { recursive: true }); shell.openPath(P('instances', n)) });
ipcMain.handle('ely', async (e, { u, p }) => {
  const ct = crypto.randomUUID(), r = await POST('https://authserver.ely.by/auth/authenticate', { username: u, password: p, clientToken: ct, requestUser: true });
  return { accessToken: r.accessToken, clientToken: ct, name: r.selectedProfile.name };
});
ipcMain.handle('play', async (e, { prof, server, st }) => {
  try {
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
    const args = [`-Xmx${s.ram}M`, ...jv, ...flat(j.arguments.jvm), j.mainClass, ...game];
    prog('Игра запущена', 100); send('log', `\n▶ ${name} → ${id}\n`);
    const c = spawn(java, args, { cwd: gd, windowsHide: true });
    c.stdout.on('data', d => send('log', d + '')); c.stderr.on('data', d => send('log', d + ''));
    c.on('error', er => send('log', 'Java не найдена: ' + er.message + '\n'));
    c.on('close', k => { prog('Игра закрыта (код ' + k + ')', 0) });
  } catch (er) { send('log', '\n✖ ' + er.message + '\n'); prog('Ошибка', 0) }
});
app.whenReady().then(() => {
  win = new BrowserWindow({ width: 1120, height: 720, minWidth: 900, minHeight: 600, autoHideMenuBar: true, backgroundColor: '#ffffff', title: 'Lime Launcher', webPreferences: { nodeIntegration: true, contextIsolation: false } });
  win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());
