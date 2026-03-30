// src/docs-server.js — Markdown docs server routed through agent workspaces
import { Router } from 'express';
import { readFile, writeFile, readdir, mkdir, stat, copyFile } from 'fs/promises';
import { join, relative, dirname, basename } from 'path';
import { randomUUID } from 'crypto';
import MarkdownIt from 'markdown-it';

const AGENTS_DIR = '/root/.openclaw/agents';
const CONFIG_FILES = new Set(['SOUL.md', 'IDENTITY.md', 'TOOLS.md', 'AGENTS.md', 'USER.md', 'HEARTBEAT.md']);
const SKIP_DIRS = new Set(['node_modules', '.comments', '.versions', '.git']);

const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: true });
const router = Router();

// ─── Auth ──────────────────────────────────────────────────────
function docsAuth(req, res, next) {
  const creds = process.env.DOCS_AUTH;
  if (!creds) return next();
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="AI Team Docs"');
    return res.status(401).send('Auth required');
  }
  if (Buffer.from(h.slice(6), 'base64').toString() === creds) return next();
  res.set('WWW-Authenticate', 'Basic realm="AI Team Docs"');
  res.status(401).send('Invalid credentials');
}
router.use(docsAuth);

// ─── Helpers ───────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function workspacePath(agent) {
  return join(AGENTS_DIR, agent, 'workspace');
}

function resolveFilePath(agent, file) {
  if (!agent || !file || file.includes('..') || file.startsWith('/')) return null;
  const ws = workspacePath(agent);
  const full = join(ws, file);
  return full.startsWith(ws + '/') ? full : null;
}

async function dirExists(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

async function fileExists(p) {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

async function getAgentList() {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  const agents = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const ws = workspacePath(e.name);
    if (!await dirExists(ws)) continue;
    const files = await findMdFiles(ws);
    if (files.length === 0) continue;
    agents.push({
      name: e.name,
      docCount: files.length,
      latestFile: files[0].path,
      latestDate: files[0].modified,
    });
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

async function findMdFiles(dir, base) {
  base = base || dir;
  let files = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        files.push(...await findMdFiles(full, base));
      } else if (e.name.endsWith('.md')) {
        const s = await stat(full);
        files.push({ path: relative(base, full), modified: s.mtime, size: s.size });
      }
    }
  } catch { /* dir may not exist */ }
  return files.sort((a, b) => b.modified - a.modified);
}

function commentsPath(agent, file) {
  return join(workspacePath(agent), '.comments', file + '.json');
}

async function loadComments(agent, file) {
  try { return JSON.parse(await readFile(commentsPath(agent, file), 'utf-8')); }
  catch { return []; }
}

async function saveComments(agent, file, comments) {
  const p = commentsPath(agent, file);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(comments, null, 2));
}

async function createVersionBackup(agent, file) {
  const fp = resolveFilePath(agent, file);
  if (!fp || !await fileExists(fp)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const versionDir = join(workspacePath(agent), '.versions', file.replace(/\.md$/, ''));
  await mkdir(versionDir, { recursive: true });
  await copyFile(fp, join(versionDir, ts + '.md'));
}

function formatDate(d) {
  return new Date(d).toLocaleDateString('es-AR', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function isConfigFile(filepath) {
  return !filepath.includes('/') && CONFIG_FILES.has(filepath);
}

// ─── Routes ────────────────────────────────────────────────────

// Home: agent cards
router.get('/', async (_req, res) => {
  try {
    const agents = await getAgentList();
    res.send(layout('AI Team Docs', renderHome(agents)));
  } catch (err) {
    res.status(500).send(layout('Error', '<p class="err">Error: ' + esc(err.message) + '</p>'));
  }
});

// Agent index
router.get('/:agent', async (req, res) => {
  const { agent } = req.params;
  const ws = workspacePath(agent);
  if (!await dirExists(ws)) return res.status(404).send(layout('404', '<p class="err">Agente no encontrado: ' + esc(agent) + '</p>'));
  const files = await findMdFiles(ws);
  const withMeta = await Promise.all(files.map(async f => ({
    ...f,
    commentCount: (await loadComments(agent, f.path)).length,
    isConfig: isConfigFile(f.path),
  })));
  res.send(layout(agent + ' — Docs', renderAgentIndex(agent, withMeta)));
});

// Save (with version backup)
router.post('/:agent/save', async (req, res) => {
  const { agent } = req.params;
  const { file, content } = req.body;
  const fp = resolveFilePath(agent, file);
  if (!fp) return res.status(400).json({ error: 'Ruta invalida' });
  try {
    await createVersionBackup(agent, file);
    await mkdir(dirname(fp), { recursive: true });
    await writeFile(fp, content, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New file
router.post('/:agent/new', async (req, res) => {
  const { agent } = req.params;
  let { file } = req.body;
  if (!file) return res.status(400).json({ error: 'file requerido' });
  if (!file.endsWith('.md')) file += '.md';
  const fp = resolveFilePath(agent, file);
  if (!fp) return res.status(400).json({ error: 'Ruta invalida' });
  try {
    await mkdir(dirname(fp), { recursive: true });
    const title = file.replace(/\.md$/, '').split('/').pop();
    await writeFile(fp, '# ' + title + '\n\n', { flag: 'wx' });
    res.json({ ok: true, file });
  } catch (err) {
    if (err.code === 'EEXIST') return res.status(409).json({ error: 'El archivo ya existe' });
    res.status(500).json({ error: err.message });
  }
});

// Comments API
router.get('/:agent/api/comments', async (req, res) => {
  const { agent } = req.params;
  const file = req.query.file;
  if (!resolveFilePath(agent, file)) return res.status(400).json([]);
  res.json(await loadComments(agent, file));
});

router.post('/:agent/api/comments', async (req, res) => {
  const { agent } = req.params;
  const { file, text, line, author } = req.body;
  if (!resolveFilePath(agent, file) || !text || !text.trim()) return res.status(400).json({ error: 'Datos incompletos' });
  const comments = await loadComments(agent, file);
  const c = {
    id: randomUUID(),
    text: text.trim(),
    line: line != null ? parseInt(line) : null,
    author: author || 'Humano',
    date: new Date().toISOString(),
  };
  comments.push(c);
  await saveComments(agent, file, comments);
  res.json(c);
});

router.post('/:agent/api/comments/delete', async (req, res) => {
  const { agent } = req.params;
  const { file, id } = req.body;
  if (!resolveFilePath(agent, file)) return res.status(400).json({ error: 'Ruta invalida' });
  const comments = (await loadComments(agent, file)).filter(c => c.id !== id);
  await saveComments(agent, file, comments);
  res.json({ ok: true });
});

// File view (catch-all — must be last)
router.get('/:agent/*filepath', async (req, res) => {
  const { agent } = req.params;
  const filepath = req.params.filepath.join('/');
  const fp = resolveFilePath(agent, filepath);
  if (!fp) return res.status(400).send(layout('Error', '<p class="err">Ruta invalida</p>'));

  try {
    const raw = await readFile(fp, 'utf-8');

    // ?raw=1 → plain text
    if (req.query.raw != null) return res.type('text/plain').send(raw);

    // ?edit=1 → editor
    if (req.query.edit != null) return res.send(layout('Editar: ' + filepath, renderEdit(agent, filepath, raw)));

    // Default → rendered view
    const html = md.render(raw);
    const comments = await loadComments(agent, filepath);
    res.send(layout(filepath, renderView(agent, filepath, raw, html, comments)));
  } catch {
    res.status(404).send(layout('404', '<p class="err">No encontrado: ' + esc(agent + '/' + filepath) + '</p>'));
  }
});

// ─── CSS ───────────────────────────────────────────────────────
const CSS = `
:root {
  --bg: #ffffff; --fg: #1a1a2e; --muted: #6b7280; --border: #e5e7eb;
  --accent: #2563eb; --accent-hover: #1d4ed8; --accent-light: #eff6ff;
  --code-bg: #f6f8fa; --comment-bg: #fefce8; --comment-border: #fde68a;
  --radius: 8px;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--fg); background: #f9fafb; line-height: 1.6; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }

.topbar { background: var(--fg); padding: 0.75rem 1.5rem; display: flex; align-items: center; gap: 1rem; }
.topbar .logo { color: #fff; font-weight: 700; font-size: 1.1rem; text-decoration: none; }
.topbar .logo:hover { opacity: 0.9; text-decoration: none; }
.container { max-width: 920px; margin: 0 auto; padding: 2rem 1.5rem; }

.breadcrumb { display: flex; gap: 0.4rem; align-items: center; margin-bottom: 1.5rem; font-size: 0.9rem; color: var(--muted); flex-wrap: wrap; }
.breadcrumb a { color: var(--accent); }
.breadcrumb .sep::before { content: '›'; margin: 0 0.1rem; }

/* Agent cards */
.page-title { font-size: 1.6rem; font-weight: 700; margin-bottom: 0.3rem; }
.page-subtitle { color: var(--muted); margin-bottom: 1.5rem; font-size: 0.95rem; }
.agent-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 1rem; }
.agent-card { background: #fff; border: 1px solid var(--border); border-radius: var(--radius); padding: 1.25rem; transition: border-color 0.15s, box-shadow 0.15s; display: block; text-decoration: none; color: var(--fg); }
.agent-card:hover { border-color: var(--accent); box-shadow: 0 2px 8px rgba(37,99,235,0.1); text-decoration: none; }
.agent-name { font-size: 1.15rem; font-weight: 600; margin-bottom: 0.4rem; text-transform: capitalize; }
.agent-meta { color: var(--muted); font-size: 0.82rem; display: flex; flex-direction: column; gap: 0.15rem; }

/* Buttons */
.btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.45rem 0.9rem; border-radius: 6px; font-size: 0.88rem; cursor: pointer; border: 1px solid var(--border); background: #fff; color: var(--fg); transition: all 0.15s; text-decoration: none; font-family: inherit; }
.btn:hover { border-color: var(--accent); color: var(--accent); text-decoration: none; }
.btn-primary { background: var(--accent); color: #fff; border-color: var(--accent); }
.btn-primary:hover { background: var(--accent-hover); color: #fff; }

/* Toolbar */
.toolbar { display: flex; gap: 0.6rem; margin-bottom: 1.5rem; flex-wrap: wrap; align-items: center; }
.toolbar .spacer { flex: 1; }
.toolbar .file-path { color: var(--muted); font-size: 0.85rem; font-family: monospace; }

/* File list */
.section-title { font-size: 1.1rem; font-weight: 600; margin: 1.5rem 0 0.6rem; }
.section-title:first-of-type { margin-top: 0; }
.file-list { list-style: none; background: #fff; border-radius: var(--radius); border: 1px solid var(--border); overflow: hidden; }
.file-item { display: flex; justify-content: space-between; align-items: center; padding: 0.8rem 1rem; border-bottom: 1px solid var(--border); transition: background 0.1s; }
.file-item:last-child { border-bottom: none; }
.file-item:hover { background: var(--accent-light); }
.file-item a { font-weight: 500; }
.file-meta { color: var(--muted); font-size: 0.82rem; display: flex; gap: 0.75rem; align-items: center; }
.badge { background: var(--accent-light); color: var(--accent); padding: 0.1rem 0.5rem; border-radius: 4px; font-size: 0.78rem; font-weight: 600; }
.dir-header { margin: 1rem 0 0.3rem; color: var(--muted); font-size: 0.85rem; font-weight: 600; font-family: monospace; }
.new-doc { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
.new-doc input[type="text"] { flex: 1; padding: 0.5rem 0.75rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.9rem; font-family: inherit; }
.empty-state { text-align: center; padding: 3rem; color: var(--muted); background: #fff; border-radius: var(--radius); border: 1px solid var(--border); }

/* Config section (collapsible) */
.config-section { margin-top: 2rem; }
.config-section summary { cursor: pointer; color: var(--muted); font-size: 0.9rem; font-weight: 600; padding: 0.5rem 0; list-style: none; display: flex; align-items: center; gap: 0.4rem; }
.config-section summary::-webkit-details-marker { display: none; }
.config-section summary::before { content: '▸'; font-size: 0.8rem; transition: transform 0.15s; }
.config-section[open] summary::before { transform: rotate(90deg); }
.config-section .file-list { border-color: #f0f0f0; }
.config-section .file-item { padding: 0.6rem 1rem; }
.config-section .file-item a { font-weight: 400; color: var(--muted); }
.config-section .file-item:hover a { color: var(--accent); }

/* Markdown body */
.markdown-body { background: #fff; padding: 2rem; border-radius: var(--radius); border: 1px solid var(--border); line-height: 1.75; font-size: 1rem; }
.markdown-body h1 { font-size: 1.9rem; margin: 0 0 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
.markdown-body h2 { font-size: 1.45rem; margin: 1.75rem 0 0.75rem; }
.markdown-body h3 { font-size: 1.2rem; margin: 1.5rem 0 0.5rem; }
.markdown-body h4 { font-size: 1.05rem; margin: 1.25rem 0 0.5rem; }
.markdown-body p { margin: 0.75rem 0; }
.markdown-body ul, .markdown-body ol { margin: 0.75rem 0; padding-left: 2rem; }
.markdown-body li { margin: 0.3rem 0; }
.markdown-body code { background: var(--code-bg); padding: 0.15em 0.4em; border-radius: 3px; font-size: 0.88em; }
.markdown-body pre { background: var(--code-bg); padding: 1rem; border-radius: 6px; overflow-x: auto; margin: 1rem 0; }
.markdown-body pre code { background: none; padding: 0; font-size: 0.85em; }
.markdown-body blockquote { border-left: 3px solid var(--accent); padding: 0.5rem 1rem; margin: 1rem 0; color: var(--muted); background: var(--accent-light); border-radius: 0 6px 6px 0; }
.markdown-body table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
.markdown-body th, .markdown-body td { border: 1px solid var(--border); padding: 0.5rem 0.75rem; text-align: left; }
.markdown-body th { background: var(--code-bg); font-weight: 600; }
.markdown-body img { max-width: 100%; border-radius: 6px; }
.markdown-body hr { border: none; border-top: 1px solid var(--border); margin: 1.5rem 0; }
.markdown-body a { color: var(--accent); }

/* Source view */
.source-view { background: #fff; border-radius: var(--radius); border: 1px solid var(--border); overflow: hidden; font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 0.82rem; display: none; }
.source-line { display: flex; min-height: 1.5em; border-bottom: 1px solid #f3f4f6; }
.source-line:last-child { border-bottom: none; }
.source-line:hover { background: var(--accent-light); }
.source-line.has-comment { background: var(--comment-bg); }
.line-num { flex-shrink: 0; width: 3.5rem; text-align: right; padding: 0.15rem 0.6rem; color: var(--muted); user-select: none; cursor: pointer; border-right: 1px solid var(--border); font-size: 0.78rem; line-height: 1.5em; }
.line-num:hover { color: var(--accent); background: var(--accent-light); }
.line-content { padding: 0.15rem 0.75rem; white-space: pre-wrap; word-break: break-all; flex: 1; line-height: 1.5em; }
.comment-count-badge { background: var(--accent); color: #fff; border-radius: 50%; width: 1.1em; height: 1.1em; display: inline-flex; align-items: center; justify-content: center; font-size: 0.65em; margin-left: 0.25rem; vertical-align: middle; }

/* Comments */
.comments-section { margin-top: 2rem; }
.comments-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
.comments-header h3 { font-size: 1.1rem; }
.comment-card { background: #fff; border: 1px solid var(--comment-border); border-radius: var(--radius); padding: 0.75rem 1rem; margin-bottom: 0.6rem; }
.comment-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem; font-size: 0.82rem; color: var(--muted); }
.comment-line-ref { background: var(--accent); color: #fff; border-radius: 4px; padding: 0.05rem 0.4rem; font-size: 0.78em; font-weight: 600; font-family: monospace; }
.comment-text { white-space: pre-wrap; font-size: 0.95rem; line-height: 1.5; }
.comment-delete { cursor: pointer; color: var(--muted); border: none; background: none; font-size: 0.9rem; padding: 0.2rem; }
.comment-delete:hover { color: #ef4444; }
.comment-form { background: #fff; border: 1px solid var(--border); border-radius: var(--radius); padding: 1rem; margin-top: 1rem; }
.comment-form textarea { width: 100%; min-height: 80px; padding: 0.65rem; border: 1px solid var(--border); border-radius: 6px; font-family: inherit; font-size: 0.92rem; resize: vertical; line-height: 1.5; }
.comment-form textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-light); }
.form-row { display: flex; gap: 0.6rem; margin-top: 0.6rem; align-items: center; flex-wrap: wrap; }
.form-row input { padding: 0.45rem 0.65rem; border: 1px solid var(--border); border-radius: 6px; font-size: 0.88rem; font-family: inherit; }
.form-row input[type="number"] { width: 5rem; }
.form-row input[type="text"] { flex: 1; min-width: 120px; }

/* Editor */
.editor { background: #fff; border-radius: var(--radius); border: 1px solid var(--border); overflow: hidden; }
.editor textarea { width: 100%; min-height: 75vh; padding: 1.25rem; font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 0.88rem; line-height: 1.65; border: none; resize: vertical; tab-size: 2; outline: none; }

/* Utils */
.err { color: #ef4444; text-align: center; padding: 2rem; }
.toast { position: fixed; bottom: 1.5rem; right: 1.5rem; background: var(--fg); color: #fff; padding: 0.65rem 1.2rem; border-radius: 8px; font-size: 0.9rem; opacity: 0; transition: opacity 0.3s; pointer-events: none; z-index: 100; }
.toast.show { opacity: 1; }

@media (max-width: 640px) {
  .container { padding: 1rem; }
  .toolbar { gap: 0.4rem; }
  .file-item { flex-direction: column; align-items: flex-start; gap: 0.3rem; }
  .markdown-body { padding: 1.25rem; }
  .form-row { flex-direction: column; }
  .form-row input[type="number"] { width: 100%; }
  .agent-grid { grid-template-columns: 1fr; }
}
`;

// ─── Client JS ─────────────────────────────────────────────────
const CLIENT_JS = `
function getAgent() {
  return document.getElementById('doc-agent')?.value || '';
}

function toggleView() {
  var rendered = document.getElementById('rendered-view');
  var source = document.getElementById('source-view');
  var btn = document.getElementById('toggle-btn');
  if (!rendered || !source) return;
  if (rendered.style.display !== 'none') {
    rendered.style.display = 'none';
    source.style.display = 'block';
    btn.textContent = 'Vista renderizada';
  } else {
    rendered.style.display = 'block';
    source.style.display = 'none';
    btn.textContent = 'Codigo fuente';
  }
}

function setCommentLine(num) {
  var el = document.getElementById('comment-line');
  if (el) el.value = num;
  var ta = document.getElementById('comment-text');
  if (ta) ta.focus();
  var form = document.getElementById('comment-form');
  if (form) form.scrollIntoView({ behavior: 'smooth' });
}

async function addComment() {
  var agent = getAgent();
  var file = document.getElementById('doc-file').value;
  var text = document.getElementById('comment-text').value.trim();
  var lineEl = document.getElementById('comment-line');
  var authorEl = document.getElementById('comment-author');
  if (!text) return;

  var body = { file: file, text: text, author: authorEl.value || 'Humano' };
  if (lineEl.value) body.line = parseInt(lineEl.value);

  var res = await fetch('/docs/' + agent + '/api/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) location.reload();
  else showToast('Error al guardar comentario');
}

async function deleteComment(file, id) {
  if (!confirm('Eliminar este comentario?')) return;
  var agent = getAgent();
  var res = await fetch('/docs/' + agent + '/api/comments/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: file, id: id }),
  });
  if (res.ok) location.reload();
}

async function saveDoc() {
  var agent = getAgent();
  var file = document.getElementById('editor-file').value;
  var content = document.getElementById('editor-content').value;
  var btn = document.getElementById('save-btn');
  btn.textContent = 'Guardando...';
  btn.disabled = true;

  var res = await fetch('/docs/' + agent + '/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: file, content: content }),
  });

  if (res.ok) {
    window.location.href = '/docs/' + agent + '/' + file;
  } else {
    btn.textContent = 'Error - Reintentar';
    btn.disabled = false;
    showToast('Error al guardar');
  }
}

async function createDoc() {
  var agent = getAgent();
  var input = document.getElementById('new-file-name');
  var file = input.value.trim();
  if (!file) return;
  if (!file.endsWith('.md')) file += '.md';

  var res = await fetch('/docs/' + agent + '/new', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: file }),
  });

  if (res.ok) {
    var data = await res.json();
    window.location.href = '/docs/' + agent + '/' + data.file + '?edit=1';
  } else {
    var data = await res.json();
    showToast(data.error || 'Error al crear archivo');
  }
}

function showToast(msg) {
  var el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(function() { el.classList.remove('show'); }, 3000);
}

document.addEventListener('DOMContentLoaded', function() {
  var editor = document.getElementById('editor-content');
  if (editor) {
    editor.addEventListener('keydown', function(e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var start = editor.selectionStart;
        editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(editor.selectionEnd);
        editor.selectionStart = editor.selectionEnd = start + 2;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveDoc();
      }
    });
  }
  var newInput = document.getElementById('new-file-name');
  if (newInput) {
    newInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') createDoc();
    });
  }
});
`;

// ─── HTML Templates ────────────────────────────────────────────
function layout(title, body) {
  return '<!DOCTYPE html><html lang="es"><head>'
    + '<meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + esc(title) + ' — AI Team Docs</title>'
    + '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css">'
    + '<style>' + CSS + '</style>'
    + '</head><body>'
    + '<nav class="topbar"><a href="/docs/" class="logo">AI Team Docs</a></nav>'
    + '<main class="container">' + body + '</main>'
    + '<div class="toast" id="toast"></div>'
    + '<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"><\/script>'
    + '<script>hljs.highlightAll();<\/script>'
    + '<script>' + CLIENT_JS + '<\/script>'
    + '</body></html>';
}

function renderHome(agents) {
  let html = '<h1 class="page-title">AI Team Docs</h1>'
    + '<p class="page-subtitle">Documentos de los agentes</p>';

  if (agents.length === 0) {
    return html + '<div class="empty-state"><p>No hay agentes con documentos.</p></div>';
  }

  html += '<div class="agent-grid">';
  for (const a of agents) {
    html += '<a href="/docs/' + esc(a.name) + '" class="agent-card">'
      + '<div class="agent-name">' + esc(a.name) + '</div>'
      + '<div class="agent-meta">'
      + '<span>' + a.docCount + ' documento' + (a.docCount !== 1 ? 's' : '') + '</span>'
      + '<span>Ultimo: ' + formatDate(a.latestDate) + '</span>'
      + '</div>'
      + '</a>';
  }
  html += '</div>';
  return html;
}

function renderAgentIndex(agent, files) {
  const docs = files.filter(f => !f.isConfig);
  const config = files.filter(f => f.isConfig);

  let html = '<div class="breadcrumb">'
    + '<a href="/docs/">Docs</a><span class="sep"></span>'
    + '<strong>' + esc(agent) + '</strong>'
    + '</div>';

  // New file form
  html += '<input type="hidden" id="doc-agent" value="' + esc(agent) + '">'
    + '<div class="new-doc">'
    + '<input type="text" id="new-file-name" placeholder="carpeta/nombre-archivo.md">'
    + '<button class="btn btn-primary" onclick="createDoc()">+ Nuevo</button>'
    + '</div>';

  // Documents section
  if (docs.length > 0) {
    html += '<div class="section-title">Documentos</div>';
    html += renderFileList(agent, docs);
  } else if (config.length > 0) {
    html += '<div class="empty-state" style="margin-bottom:1.5rem"><p>Sin documentos de contenido. Solo archivos de configuracion.</p></div>';
  } else {
    html += '<div class="empty-state"><p>Sin documentos todavia.</p></div>';
  }

  // Config section (collapsible)
  if (config.length > 0) {
    html += '<details class="config-section">'
      + '<summary>Configuracion (' + config.length + ')</summary>'
      + '<ul class="file-list">';
    for (const f of config) {
      html += '<li class="file-item">'
        + '<a href="/docs/' + esc(agent) + '/' + encodeURI(f.path) + '">' + esc(f.path) + '</a>'
        + '<span class="file-meta">'
        + (f.commentCount ? '<span class="badge">' + f.commentCount + '</span>' : '')
        + '<span>' + formatSize(f.size) + '</span>'
        + '</span>'
        + '</li>';
    }
    html += '</ul></details>';
  }

  return html;
}

function renderFileList(agent, files) {
  // Group by directory
  const dirs = {};
  for (const f of files) {
    const parts = f.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    if (!dirs[dir]) dirs[dir] = [];
    dirs[dir].push(f);
  }

  let html = '';
  for (const [dir, dirFiles] of Object.entries(dirs)) {
    if (dir) html += '<div class="dir-header">' + esc(dir) + '/</div>';
    html += '<ul class="file-list">';
    for (const f of dirFiles) {
      const name = f.path.split('/').pop();
      html += '<li class="file-item">'
        + '<a href="/docs/' + esc(agent) + '/' + encodeURI(f.path) + '">' + esc(name) + '</a>'
        + '<span class="file-meta">'
        + (f.commentCount ? '<span class="badge">' + f.commentCount + ' comentario' + (f.commentCount > 1 ? 's' : '') + '</span>' : '')
        + '<span>' + formatSize(f.size) + '</span>'
        + '<span>' + formatDate(f.modified) + '</span>'
        + '</span>'
        + '</li>';
    }
    html += '</ul>';
  }
  return html;
}

function renderView(agent, file, raw, renderedHtml, comments) {
  const lines = raw.split('\n');
  const commentsByLine = {};
  for (const c of comments) {
    if (c.line) {
      if (!commentsByLine[c.line]) commentsByLine[c.line] = [];
      commentsByLine[c.line].push(c);
    }
  }

  // Breadcrumb
  let html = '<div class="breadcrumb">'
    + '<a href="/docs/">Docs</a><span class="sep"></span>'
    + '<a href="/docs/' + esc(agent) + '">' + esc(agent) + '</a><span class="sep"></span>'
    + '<strong>' + esc(file) + '</strong>'
    + '</div>';

  // Hidden inputs for JS
  html += '<input type="hidden" id="doc-agent" value="' + esc(agent) + '">';

  // Toolbar
  html += '<div class="toolbar">'
    + '<a href="/docs/' + esc(agent) + '" class="btn">Volver</a>'
    + '<button class="btn" id="toggle-btn" onclick="toggleView()">Codigo fuente</button>'
    + '<a href="/docs/' + esc(agent) + '/' + encodeURI(file) + '?edit=1" class="btn">Editar</a>'
    + '<span class="spacer"></span>'
    + '<span class="file-path">' + esc(file) + '</span>'
    + '</div>';

  // Rendered view
  html += '<div id="rendered-view" class="markdown-body">' + renderedHtml + '</div>';

  // Source view
  html += '<div id="source-view" class="source-view">';
  for (let i = 0; i < lines.length; i++) {
    const num = i + 1;
    const lc = commentsByLine[num];
    html += '<div class="source-line' + (lc ? ' has-comment' : '') + '" id="L' + num + '">'
      + '<span class="line-num" onclick="setCommentLine(' + num + ')">'
      + num
      + (lc ? '<span class="comment-count-badge">' + lc.length + '</span>' : '')
      + '</span>'
      + '<span class="line-content">' + esc(lines[i]) + '</span>'
      + '</div>';
  }
  html += '</div>';

  // Comments section
  html += '<div class="comments-section">'
    + '<div class="comments-header"><h3>Comentarios (' + comments.length + ')</h3></div>';

  if (comments.length) {
    const sorted = [...comments].sort((a, b) => (a.line || 99999) - (b.line || 99999));
    for (const c of sorted) {
      html += '<div class="comment-card">'
        + '<div class="comment-meta">'
        + '<span>'
        + '<strong>' + esc(c.author) + '</strong>'
        + (c.line ? ' <span class="comment-line-ref">L' + c.line + '</span>' : '')
        + ' &middot; ' + formatDate(c.date)
        + '</span>'
        + '<button class="comment-delete" onclick="deleteComment(\'' + esc(file).replace(/'/g, "\\'") + '\',\'' + c.id + '\')" title="Eliminar">&#10005;</button>'
        + '</div>'
        + '<div class="comment-text">' + esc(c.text) + '</div>'
        + '</div>';
    }
  }

  html += '<div class="comment-form" id="comment-form">'
    + '<input type="hidden" id="doc-file" value="' + esc(file) + '">'
    + '<textarea id="comment-text" placeholder="Escribi tu comentario... (Tip: en la vista de codigo fuente, click en un numero de linea para referenciarlo)"></textarea>'
    + '<div class="form-row">'
    + '<input type="number" id="comment-line" placeholder="Linea" min="1">'
    + '<input type="text" id="comment-author" placeholder="Autor" value="Humano">'
    + '<button class="btn btn-primary" onclick="addComment()">Comentar</button>'
    + '</div>'
    + '</div>';

  html += '</div>';
  return html;
}

function renderEdit(agent, file, raw) {
  return '<div class="breadcrumb">'
    + '<a href="/docs/">Docs</a><span class="sep"></span>'
    + '<a href="/docs/' + esc(agent) + '">' + esc(agent) + '</a><span class="sep"></span>'
    + '<a href="/docs/' + esc(agent) + '/' + encodeURI(file) + '">' + esc(file) + '</a><span class="sep"></span>'
    + '<strong>Editar</strong>'
    + '</div>'
    + '<input type="hidden" id="doc-agent" value="' + esc(agent) + '">'
    + '<div class="toolbar">'
    + '<a href="/docs/' + esc(agent) + '/' + encodeURI(file) + '" class="btn">Cancelar</a>'
    + '<button class="btn btn-primary" id="save-btn" onclick="saveDoc()">Guardar</button>'
    + '<span class="spacer"></span>'
    + '<span class="file-path">' + esc(file) + '</span>'
    + '</div>'
    + '<div class="editor">'
    + '<input type="hidden" id="editor-file" value="' + esc(file) + '">'
    + '<textarea id="editor-content">' + esc(raw) + '</textarea>'
    + '</div>';
}

export default router;
