const BASE = 'https://api.github.com';

function encodePath(filePath) {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

async function ghFetch(urlPath, token, options = {}) {
  const { headers: extraHeaders, ...rest } = options;
  const res = await fetch(`${BASE}${urlPath}`, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Adonix-Web',
      ...extraHeaders,
    },
  });
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error('Token de GitHub inválido o expirado. Reconfigura en ajustes.');
    }
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function getViewer(token) {
  const user = await ghFetch('/user', token);
  return {
    login: user.login || '',
    name: user.name || user.login || '',
    email: user.email || '',
  };
}

async function validateToken(token) {
  try {
    return await getViewer(token);
  } catch {
    return null;
  }
}

async function listRepos(token) {
  const repos = await ghFetch('/user/repos?sort=pushed&per_page=50', token);
  return repos.map(r => ({
    name: r.name,
    owner: r.owner.login,
    fullName: r.full_name,
    description: r.description || '',
    language: r.language || '',
    private: r.private,
    updatedAt: r.updated_at,
    defaultBranch: r.default_branch,
  }));
}

async function getTree(token, owner, repo) {
  const repoData = await ghFetch(`/repos/${owner}/${repo}`, token);
  const branch = repoData.default_branch || 'main';
  const data = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    token,
  );
  return data.tree
    .filter(t => t.type === 'blob')
    .map(t => ({ path: t.path, size: t.size }));
}

async function readFile(token, owner, repo, filePath) {
  const data = await ghFetch(`/repos/${owner}/${repo}/contents/${encodePath(filePath)}`, token);
  return {
    content: Buffer.from(data.content, 'base64').toString('utf8'),
    sha: data.sha,
  };
}

async function writeFile(token, owner, repo, filePath, content, author = {}) {
  let sha;
  try {
    const existing = await ghFetch(
      `/repos/${owner}/${repo}/contents/${encodePath(filePath)}`,
      token,
    );
    sha = existing.sha;
  } catch {}

  const filename = filePath.split('/').pop();
  const body = {
    message: `Update ${filename}`,
    content: Buffer.from(content).toString('base64'),
    committer: {
      name: author.name || 'Adonix',
      email: author.email || 'adonix@bot.local',
    },
  };
  if (sha) body.sha = sha;

  return ghFetch(`/repos/${owner}/${repo}/contents/${encodePath(filePath)}`, token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

module.exports = {
  listRepos,
  getTree,
  readFile,
  writeFile,
  validateToken,
  getViewer,
};
