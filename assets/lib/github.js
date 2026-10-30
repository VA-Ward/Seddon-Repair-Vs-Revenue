// Minimal GitHub REST client for the Admin page.
// Publishes several files in a single commit (data + photos) using the Git Data API.

export class GitHub {
  constructor({ owner, repo, branch = 'main', token }) {
    Object.assign(this, { owner, repo, branch, token });
    this.base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  async req(path, opts = {}) {
    const r = await fetch(path.startsWith('http') ? path : `${this.base}${path}`, {
      ...opts,
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    });
    if (r.status === 404 && opts.allow404) return null;
    if (!r.ok) {
      let msg = `${r.status} ${r.statusText}`;
      try { const j = await r.json(); if (j.message) msg = `${r.status}: ${j.message}`; } catch { /* no body */ }
      if (r.status === 401) msg = 'GitHub rejected the token (401). Create a new fine-grained token and paste it again.';
      if (r.status === 403) msg = `GitHub refused (403). The token needs "Contents: Read and write" on ${this.owner}/${this.repo}. ${msg}`;
      if (r.status === 404) msg = `Not found (404). Check the account name, repository name and branch, and that the token can see ${this.owner}/${this.repo}.`;
      throw new Error(msg);
    }
    return r.status === 204 ? null : r.json();
  }

  async check() {
    const repo = await this.req('');
    await this.req(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
    return { private: repo.private, pages: repo.has_pages, url: repo.html_url, canPush: repo.permissions?.push !== false };
  }

  /** Raw bytes of a file at the branch head, or null if it doesn't exist. */
  async readFile(path) {
    const meta = await this.req(`/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(this.branch)}`, { allow404: true });
    if (!meta) return null;
    if (meta.content && meta.encoding === 'base64') return { sha: meta.sha, bytes: b64ToBytes(meta.content.replace(/\n/g, '')) };
    const blob = await this.req(`/git/blobs/${meta.sha}`);
    return { sha: meta.sha, bytes: b64ToBytes(blob.content.replace(/\n/g, '')) };
  }

  /**
   * files: [{ path, bytes (Uint8Array) | text (string) | delete: true }]
   * One commit on the branch. Retries once if the branch moved underneath us.
   */
  async commit(files, message) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ref = await this.req(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
      const head = await this.req(`/git/commits/${ref.object.sha}`);
      const tree = [];
      for (const f of files) {
        if (f.delete) { tree.push({ path: f.path, mode: '100644', type: 'blob', sha: null }); continue; }
        const bytes = f.bytes || new TextEncoder().encode(f.text);
        const blob = await this.req('/git/blobs', { method: 'POST', body: JSON.stringify({ content: bytesToB64(bytes), encoding: 'base64' }) });
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const newTree = await this.req('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree }) });
      const c = await this.req('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [ref.object.sha] }) });
      try {
        await this.req(`/git/refs/heads/${encodeURIComponent(this.branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: c.sha, force: false }) });
        return c;
      } catch (e) {
        if (attempt === 0 && /422|409|fast forward/i.test(e.message)) continue;
        throw e;
      }
    }
    throw new Error('The repository changed while publishing. Try again.');
  }

  async runWorkflow(file, inputs = {}) {
    return this.req(`/actions/workflows/${encodeURIComponent(file)}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: this.branch, inputs }) });
  }

  async lastRun(file) {
    const r = await this.req(`/actions/workflows/${encodeURIComponent(file)}/runs?per_page=1`, { allow404: true });
    return r?.workflow_runs?.[0] || null;
  }
}

export function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(b64);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
